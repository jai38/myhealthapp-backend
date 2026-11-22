# Phone sign-in with WhatsApp codes (Phase 5 task 10), through the Meta Cloud API (task 6).
#
# Parameter Store holds the secrets as placeholders; the owner sets the real values (README section 17).
# Terraform never reads or overwrites them. Meta's side (business verification, the number, the
# authentication template, the app and its webhook) is set up in Meta Business Manager, not here.
#
# The API stays on WHATSAPP_SENDER = "disabled" (code routes answer 503) until whatsapp_sender = "meta".
# Spend: Meta bills outside AWS, so the API writes a count metric (Ayoreni/PhoneSignIn, OtpCodesSent)
# and the alarms below watch it.

variable "whatsapp_sender" {
  description = "Sender for sign-in codes: disabled (code routes answer 503) or meta. Switch to meta only after the template is approved and the secrets are set."
  type        = string
  default     = "disabled"

  validation {
    condition     = contains(["disabled", "meta"], var.whatsapp_sender)
    error_message = "whatsapp_sender must be disabled or meta (the memory sender is for tests only)."
  }
}

variable "meta_whatsapp_phone_number_id" {
  description = "Meta WhatsApp phone number id (not secret). Required when whatsapp_sender is meta."
  type        = string
  default     = ""
}

variable "meta_whatsapp_template_name" {
  description = "Name of the approved authentication template (not secret). Required when whatsapp_sender is meta."
  type        = string
  default     = ""
}

variable "meta_whatsapp_template_language" {
  description = "Language code of the template."
  type        = string
  default     = "en"
}

variable "otp_daily_cap" {
  description = "Codes the API sends per UTC day across the whole service; above it, requests get 429 DAILY_LIMIT."
  type        = number
  default     = 2000
}

variable "otp_daily_alarm_threshold" {
  description = "Alarm when more codes than this are sent in a day (below the cap, so you hear first)."
  type        = number
  default     = 1500
}

variable "dev_whatsapp_sender" {
  description = "Sender for the dev API. Dev shares the WhatsApp account; Meta allows one webhook URL per app, so dev reports late delivery only if it has its own Meta app."
  type        = string
  default     = "disabled"

  validation {
    condition     = contains(["disabled", "meta"], var.dev_whatsapp_sender)
    error_message = "dev_whatsapp_sender must be disabled or meta."
  }
}

locals {
  whatsapp_secret_names = ["OTP_HMAC_SECRET", "META_WHATSAPP_TOKEN", "META_APP_SECRET", "META_WEBHOOK_VERIFY_TOKEN"]

  whatsapp_environment = concat(
    [
      { name = "WHATSAPP_SENDER", value = var.whatsapp_sender },
      { name = "META_WHATSAPP_TEMPLATE_LANGUAGE", value = var.meta_whatsapp_template_language },
      { name = "OTP_DAILY_CAP", value = tostring(var.otp_daily_cap) },
    ],
    var.meta_whatsapp_phone_number_id != "" ? [{ name = "META_WHATSAPP_PHONE_NUMBER_ID", value = var.meta_whatsapp_phone_number_id }] : [],
    var.meta_whatsapp_template_name != "" ? [{ name = "META_WHATSAPP_TEMPLATE_NAME", value = var.meta_whatsapp_template_name }] : [],
  )

  whatsapp_secrets = [for name in local.whatsapp_secret_names : { name = name, valueFrom = local.secret_arn[name] }]
}

# ---------------------------------------------------------------------------
# Spend alarms on the API's own count of codes sent
# ---------------------------------------------------------------------------

resource "aws_cloudwatch_metric_alarm" "otp_daily_volume" {
  alarm_name          = "${local.name}-otp-daily-volume"
  alarm_description   = "More sign-in codes sent in a day than expected (WhatsApp spend). Check for abuse before raising the threshold."
  namespace           = "Ayoreni/PhoneSignIn"
  metric_name         = "OtpCodesSent"
  dimensions          = { Deployment = "prod" }
  statistic           = "Sum"
  period              = 86400
  evaluation_periods  = 1
  threshold           = var.otp_daily_alarm_threshold
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_sns_topic.alerts.arn]
}

resource "aws_cloudwatch_metric_alarm" "otp_cap_reached" {
  alarm_name          = "${local.name}-otp-daily-cap-reached"
  alarm_description   = "The daily cap on sign-in codes was reached: new sign-ins get 429 until midnight UTC."
  namespace           = "Ayoreni/PhoneSignIn"
  metric_name         = "OtpDailyCapReached"
  dimensions          = { Deployment = "prod" }
  statistic           = "Sum"
  period              = 300
  evaluation_periods  = 1
  threshold           = 0
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_sns_topic.alerts.arn]
}

resource "aws_cloudwatch_metric_alarm" "otp_send_failures" {
  alarm_name          = "${local.name}-otp-send-failures"
  alarm_description   = "WhatsApp refused code sends (token, template or Meta outage)."
  namespace           = "Ayoreni/PhoneSignIn"
  metric_name         = "OtpSendFailed"
  dimensions          = { Deployment = "prod" }
  statistic           = "Sum"
  period              = 900
  evaluation_periods  = 1
  threshold           = 10
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_sns_topic.alerts.arn]
}
