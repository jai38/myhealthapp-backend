# V1 test environment: about 100 users. No secrets belong in this file.
# Sizes are the roadmap's "V1 test" column. To move up a stage, change the values below.

environment = "v1"
region      = "ap-south-1"

# REQUIRED: replace with your address. Alarm and budget emails go here.
alert_email = "CHANGE_ME@example.com"

# --- Sizes -----------------------------------------------------------------
api_cpu           = 256 # 0.25 vCPU
api_memory        = 512 # 0.5 GB
api_desired_count = 1

worker_cpu       = 256
worker_memory    = 512
worker_max_count = 1

db_instance_class        = "db.t4g.micro"
db_allocated_storage     = 20
db_multi_az              = false
db_backup_retention_days = 7
db_deletion_protection   = true
db_skip_final_snapshot   = false

log_retention_days = 14
budget_monthly_usd = 60

# --- Application -----------------------------------------------------------
# Owner approved Gemini (gemini-2.5-flash) for this version on 2 Nov 2026. The worker will not start while false.
ai_provider_approved = true

# Keep false until the app has verification screens (Phase 5).
email_verification_required = false

# Fill in when the SES sender exists, for example "no-reply@your-domain".
ses_identity = ""
email_from   = ""

# --- Entry point (optional) ------------------------------------------------
custom_domain_name  = ""
acm_certificate_arn = ""

# --- Deploy role -----------------------------------------------------------
github_oidc_subject_prefix  = "repo:jai38@71269258/myhealthapp-backend@1415279162"
github_allowed_refs         = ["refs/heads/main"]
create_github_oidc_provider = true
