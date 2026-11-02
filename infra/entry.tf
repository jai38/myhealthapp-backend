# API entry: API Gateway HTTP API -> VPC link -> Cloud Map -> API task.
# Optional custom domain, so the app can keep one address while the entry point changes later.

resource "aws_apigatewayv2_vpc_link" "main" {
  name               = local.name
  security_group_ids = [aws_security_group.vpc_link.id]
  subnet_ids         = aws_subnet.public[*].id
}

resource "aws_apigatewayv2_api" "main" {
  name          = local.name
  protocol_type = "HTTP"
  # CORS is handled by the Express app, which knows the allowed origin.
}

resource "aws_apigatewayv2_integration" "api" {
  api_id                 = aws_apigatewayv2_api.main.id
  integration_type       = "HTTP_PROXY"
  integration_method     = "ANY"
  integration_uri        = aws_service_discovery_service.api.arn
  connection_type        = "VPC_LINK"
  connection_id          = aws_apigatewayv2_vpc_link.main.id
  payload_format_version = "1.0"
  timeout_milliseconds   = 30000
}

resource "aws_apigatewayv2_route" "default" {
  api_id    = aws_apigatewayv2_api.main.id
  route_key = "$default"
  target    = "integrations/${aws_apigatewayv2_integration.api.id}"
}

resource "aws_apigatewayv2_stage" "default" {
  api_id      = aws_apigatewayv2_api.main.id
  name        = "$default"
  auto_deploy = true

  default_route_settings {
    throttling_rate_limit  = var.api_throttle_rate
    throttling_burst_limit = var.api_throttle_burst
  }
}

resource "aws_apigatewayv2_domain_name" "custom" {
  count = var.custom_domain_name != "" ? 1 : 0

  domain_name = var.custom_domain_name

  domain_name_configuration {
    certificate_arn = var.acm_certificate_arn
    endpoint_type   = "REGIONAL"
    security_policy = "TLS_1_2"
  }

  lifecycle {
    precondition {
      condition     = var.acm_certificate_arn != ""
      error_message = "acm_certificate_arn is required when custom_domain_name is set."
    }
  }
}

resource "aws_apigatewayv2_api_mapping" "custom" {
  count = var.custom_domain_name != "" ? 1 : 0

  api_id      = aws_apigatewayv2_api.main.id
  domain_name = aws_apigatewayv2_domain_name.custom[0].id
  stage       = aws_apigatewayv2_stage.default.id
}

# ---------------------------------------------------------------------------
# SES identity for account emails (a domain, or a single address for early testing).
# New accounts start in the SES sandbox: see README.
# ---------------------------------------------------------------------------

resource "aws_sesv2_email_identity" "main" {
  count = var.ses_identity != "" ? 1 : 0

  email_identity = var.ses_identity
}
