# Dev copy inside the v1 stack, on the same AWS account. Turn on with dev_enabled = true.
#
# Shared with prod (no extra cost): VPC, RDS instance, ECS cluster, ECR repository, VPC link, KMS key.
# Separate from prod:
#   database  : schema "dev" on the same RDS database (prod uses "public")
#   files     : its own bucket, myhealth-v1-dev-documents-<account>
#   secrets   : /myhealth/v1/dev/* (its own JWT secret, so prod tokens never work in dev)
#   API       : its own ECS service and its own API Gateway URL
#   roles     : its own task, execution and GitHub deploy roles; none can touch prod data
# Extraction runs inline in the dev API (no dev queues or worker). The API refuses to start if its
# DEPLOYMENT_ENV, schema and bucket disagree (validateProductionConfig, check 9).
#
# Cost while dev_api_desired_count = 1: about USD 10 a month (one 0.25 vCPU ARM task and its public IP).
# Set it to 0 (or run infra/dev-env.ps1 Stop) when nobody is testing.

locals {
  dev      = var.dev_enabled
  dev_name = "${local.name}-dev"

  dev_secret_parameters = {
    DATABASE_URL       = "Dev database URL: the same RDS host with ?schema=dev&sslmode=require."
    JWT_SECRET         = "Dev signing secret. Different from prod, at least 32 random characters."
    SEED_USER_PASSWORD = "Password for every seeded dev account (12+ characters)."
  }

  dev_bucket_name = "${local.name}-dev-documents-${local.account_id}"

  # Prod API settings, minus the ones dev replaces.
  dev_overridden_env = ["STORAGE_BUCKET", "EXTRACTION_MODE", "EXTRACTION_JOBS_QUEUE_URL", "EXTRACTION_RESULTS_QUEUE_URL", "EMAIL_PROVIDER", "EMAIL_FROM", "SES_REGION", "EMAIL_VERIFICATION_REQUIRED", "APP_BASE_URL"]
  dev_api_environment = concat(
    [for e in local.api_environment : e if !contains(local.dev_overridden_env, e.name)],
    [
      { name = "DEPLOYMENT_ENV", value = "dev" },
      { name = "STORAGE_BUCKET", value = local.dev_bucket_name },
      { name = "EXTRACTION_MODE", value = "inline" },
      { name = "AI_EXTRACTION_PROVIDER", value = "gemini" },
      { name = "AI_PROVIDER_APPROVED", value = tostring(var.ai_provider_approved) },
      { name = "EMAIL_VERIFICATION_REQUIRED", value = "false" },
    ],
  )
}

variable "dev_enabled" {
  description = "Create the dev copy (schema dev, dev bucket, dev API) next to prod in this stack."
  type        = bool
  default     = false
}

variable "dev_api_desired_count" {
  description = "Dev API tasks. 0 pauses dev and its cost; data stays."
  type        = number
  default     = 1
}

# ---------------------------------------------------------------------------
# Files
# ---------------------------------------------------------------------------

resource "aws_s3_bucket" "dev_documents" {
  count         = local.dev ? 1 : 0
  bucket        = local.dev_bucket_name
  force_destroy = true # synthetic data only
}

resource "aws_s3_bucket_ownership_controls" "dev_documents" {
  count  = local.dev ? 1 : 0
  bucket = aws_s3_bucket.dev_documents[0].id
  rule {
    object_ownership = "BucketOwnerEnforced"
  }
}

resource "aws_s3_bucket_public_access_block" "dev_documents" {
  count                   = local.dev ? 1 : 0
  bucket                  = aws_s3_bucket.dev_documents[0].id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_server_side_encryption_configuration" "dev_documents" {
  count  = local.dev ? 1 : 0
  bucket = aws_s3_bucket.dev_documents[0].id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm     = "aws:kms"
      kms_master_key_id = aws_kms_key.data.arn
    }
    bucket_key_enabled = true
  }
}

resource "aws_s3_bucket_cors_configuration" "dev_documents" {
  count  = local.dev ? 1 : 0
  bucket = aws_s3_bucket.dev_documents[0].id
  cors_rule {
    allowed_methods = ["GET", "PUT", "HEAD"]
    allowed_origins = var.web_origins
    allowed_headers = ["*"]
    expose_headers  = ["ETag"]
    max_age_seconds = 3000
  }
}

data "aws_iam_policy_document" "dev_documents_bucket" {
  count = local.dev ? 1 : 0
  statement {
    sid       = "DenyInsecureTransport"
    effect    = "Deny"
    actions   = ["s3:*"]
    resources = [aws_s3_bucket.dev_documents[0].arn, "${aws_s3_bucket.dev_documents[0].arn}/*"]
    principals {
      type        = "*"
      identifiers = ["*"]
    }
    condition {
      test     = "Bool"
      variable = "aws:SecureTransport"
      values   = ["false"]
    }
  }
}

resource "aws_s3_bucket_policy" "dev_documents" {
  count      = local.dev ? 1 : 0
  bucket     = aws_s3_bucket.dev_documents[0].id
  policy     = data.aws_iam_policy_document.dev_documents_bucket[0].json
  depends_on = [aws_s3_bucket_public_access_block.dev_documents]
}

# ---------------------------------------------------------------------------
# Secrets: placeholders; the owner sets values (docs/dev-data/README.md).
# ---------------------------------------------------------------------------

resource "aws_ssm_parameter" "dev_secret" {
  for_each = local.dev ? local.dev_secret_parameters : {}

  name        = "${local.param_prefix}/dev/${each.key}"
  description = each.value
  type        = "SecureString"
  key_id      = aws_kms_key.data.arn
  value       = "REPLACE_ME_BY_OWNER"

  lifecycle {
    ignore_changes = [value, key_id]
  }
}

# ---------------------------------------------------------------------------
# Logs and roles
# ---------------------------------------------------------------------------

resource "aws_cloudwatch_log_group" "dev" {
  for_each          = local.dev ? toset(["api", "migrate", "seed"]) : toset([])
  name              = "/ecs/${local.dev_name}/${each.key}"
  retention_in_days = min(var.log_retention_days, 7)
}

resource "aws_iam_role" "dev_execution" {
  count              = local.dev ? 1 : 0
  name               = "${local.dev_name}-execution"
  assume_role_policy = data.aws_iam_policy_document.ecs_tasks_assume.json
}

data "aws_iam_policy_document" "dev_execution" {
  count = local.dev ? 1 : 0

  statement {
    sid       = "EcrLogin"
    actions   = ["ecr:GetAuthorizationToken"]
    resources = ["*"]
  }
  statement {
    sid       = "EcrPull"
    actions   = ["ecr:BatchCheckLayerAvailability", "ecr:BatchGetImage", "ecr:GetDownloadUrlForLayer"]
    resources = [aws_ecr_repository.app.arn]
  }
  statement {
    sid       = "Logs"
    actions   = ["logs:CreateLogStream", "logs:PutLogEvents"]
    resources = [for g in aws_cloudwatch_log_group.dev : "${g.arn}:*"]
  }
  # Dev secrets, plus the shared Gemini key for inline extraction. No prod DATABASE_URL or JWT_SECRET.
  statement {
    sid       = "ReadDevSecrets"
    actions   = ["ssm:GetParameters"]
    resources = concat([for p in aws_ssm_parameter.dev_secret : p.arn], [aws_ssm_parameter.secret["GEMINI_API_KEY"].arn])
  }
  statement {
    sid       = "DecryptSecrets"
    actions   = ["kms:Decrypt"]
    resources = [aws_kms_key.data.arn]
  }
}

resource "aws_iam_role_policy" "dev_execution" {
  count  = local.dev ? 1 : 0
  name   = "execution"
  role   = aws_iam_role.dev_execution[0].id
  policy = data.aws_iam_policy_document.dev_execution[0].json
}

# API and seed both work on the dev bucket only. The seed also reads generated images from seed-assets/.
resource "aws_iam_role" "dev_task" {
  count              = local.dev ? 1 : 0
  name               = "${local.dev_name}-task"
  assume_role_policy = data.aws_iam_policy_document.ecs_tasks_assume.json
}

data "aws_iam_policy_document" "dev_task" {
  count = local.dev ? 1 : 0

  statement {
    sid       = "DocumentObjects"
    actions   = ["s3:GetObject", "s3:PutObject", "s3:DeleteObject"]
    resources = ["${aws_s3_bucket.dev_documents[0].arn}/documents/*"]
  }
  statement {
    sid       = "SeedAssets"
    actions   = ["s3:GetObject"]
    resources = ["${aws_s3_bucket.dev_documents[0].arn}/seed-assets/*"]
  }
  statement {
    sid       = "ListBucket"
    actions   = ["s3:ListBucket"]
    resources = [aws_s3_bucket.dev_documents[0].arn]
  }
  statement {
    sid       = "UseDataKey"
    actions   = ["kms:Decrypt", "kms:GenerateDataKey", "kms:DescribeKey"]
    resources = [aws_kms_key.data.arn]
  }
}

resource "aws_iam_role_policy" "dev_task" {
  count  = local.dev ? 1 : 0
  name   = "dev"
  role   = aws_iam_role.dev_task[0].id
  policy = data.aws_iam_policy_document.dev_task[0].json
}

# ---------------------------------------------------------------------------
# Task definitions
# ---------------------------------------------------------------------------

locals {
  dev_secret_arn = { for k, p in aws_ssm_parameter.dev_secret : k => p.arn }

  dev_log = { for k, g in aws_cloudwatch_log_group.dev : k => {
    logDriver = "awslogs"
    options = {
      "awslogs-group"         = g.name
      "awslogs-region"        = var.region
      "awslogs-stream-prefix" = k
    }
  } }
}

resource "aws_ecs_task_definition" "dev_api" {
  count                    = local.dev ? 1 : 0
  family                   = "${local.dev_name}-api"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = 256
  memory                   = 512
  execution_role_arn       = aws_iam_role.dev_execution[0].arn
  task_role_arn            = aws_iam_role.dev_task[0].arn

  runtime_platform {
    cpu_architecture        = "ARM64"
    operating_system_family = "LINUX"
  }

  container_definitions = jsonencode([{
    name         = "api"
    image        = local.image
    essential    = true
    portMappings = [{ containerPort = local.api_container_port, protocol = "tcp" }]
    environment  = local.dev_api_environment
    secrets = [
      { name = "DATABASE_URL", valueFrom = local.dev_secret_arn["DATABASE_URL"] },
      { name = "JWT_SECRET", valueFrom = local.dev_secret_arn["JWT_SECRET"] },
      { name = "GEMINI_API_KEY", valueFrom = aws_ssm_parameter.secret["GEMINI_API_KEY"].arn },
    ]
    healthCheck = {
      command     = ["CMD-SHELL", "wget -q -O /dev/null http://127.0.0.1:${local.api_container_port}/healthz || exit 1"]
      interval    = 30
      timeout     = 5
      retries     = 3
      startPeriod = 30
    }
    stopTimeout      = 30
    logConfiguration = local.dev_log["api"]
  }])
}

resource "aws_ecs_task_definition" "dev_migrate" {
  count                    = local.dev ? 1 : 0
  family                   = "${local.dev_name}-migrate"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = 256
  memory                   = 512
  execution_role_arn       = aws_iam_role.dev_execution[0].arn

  runtime_platform {
    cpu_architecture        = "ARM64"
    operating_system_family = "LINUX"
  }

  container_definitions = jsonencode([{
    name             = "migrate"
    image            = local.image
    essential        = true
    command          = ["prisma", "migrate", "deploy"]
    secrets          = [{ name = "DATABASE_URL", valueFrom = local.dev_secret_arn["DATABASE_URL"] }]
    logConfiguration = local.dev_log["migrate"]
  }])
}

# One-shot. Default command resets and reseeds; override the command at run time for other flags.
resource "aws_ecs_task_definition" "dev_seed" {
  count                    = local.dev ? 1 : 0
  family                   = "${local.dev_name}-seed"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = 512
  memory                   = 1024
  execution_role_arn       = aws_iam_role.dev_execution[0].arn
  task_role_arn            = aws_iam_role.dev_task[0].arn

  runtime_platform {
    cpu_architecture        = "ARM64"
    operating_system_family = "LINUX"
  }

  container_definitions = jsonencode([{
    name      = "seed"
    image     = local.image
    essential = true
    command   = ["node", "dist/scripts/seed-dev/index.js", "--target", "dev", "--reset"]
    environment = [
      { name = "NODE_ENV", value = "production" },
      { name = "DEPLOYMENT_ENV", value = "dev" },
      { name = "AWS_REGION", value = var.region },
      { name = "STORAGE_BUCKET", value = local.dev_bucket_name },
      { name = "STORAGE_REGION", value = var.region },
    ]
    secrets = [
      { name = "DATABASE_URL", valueFrom = local.dev_secret_arn["DATABASE_URL"] },
      { name = "SEED_USER_PASSWORD", valueFrom = local.dev_secret_arn["SEED_USER_PASSWORD"] },
    ]
    logConfiguration = local.dev_log["seed"]
  }])
}

# ---------------------------------------------------------------------------
# Service and entry point
# ---------------------------------------------------------------------------

resource "aws_service_discovery_service" "dev_api" {
  count         = local.dev ? 1 : 0
  name          = "api-dev"
  force_destroy = true

  dns_config {
    namespace_id   = aws_service_discovery_private_dns_namespace.main.id
    routing_policy = "MULTIVALUE"
    dns_records {
      type = "SRV"
      ttl  = 10
    }
  }
}

resource "aws_ecs_service" "dev_api" {
  count           = local.dev ? 1 : 0
  name            = "api-dev"
  cluster         = aws_ecs_cluster.main.id
  task_definition = aws_ecs_task_definition.dev_api[0].arn
  desired_count   = var.dev_api_desired_count
  launch_type     = "FARGATE"

  deployment_minimum_healthy_percent = 0 # dev can blink during a deploy
  deployment_maximum_percent         = 100

  deployment_circuit_breaker {
    enable   = true
    rollback = true
  }

  network_configuration {
    subnets          = aws_subnet.public[*].id
    security_groups  = [aws_security_group.api.id]
    assign_public_ip = true
  }

  service_registries {
    registry_arn   = aws_service_discovery_service.dev_api[0].arn
    container_name = "api"
    container_port = local.api_container_port
  }

  lifecycle {
    ignore_changes = [task_definition]
  }
}

resource "aws_apigatewayv2_api" "dev" {
  count         = local.dev ? 1 : 0
  name          = local.dev_name
  protocol_type = "HTTP"
}

resource "aws_apigatewayv2_integration" "dev_api" {
  count                  = local.dev ? 1 : 0
  api_id                 = aws_apigatewayv2_api.dev[0].id
  integration_type       = "HTTP_PROXY"
  integration_method     = "ANY"
  integration_uri        = aws_service_discovery_service.dev_api[0].arn
  connection_type        = "VPC_LINK"
  connection_id          = aws_apigatewayv2_vpc_link.main.id
  payload_format_version = "1.0"
  timeout_milliseconds   = 30000
}

resource "aws_apigatewayv2_route" "dev_default" {
  count     = local.dev ? 1 : 0
  api_id    = aws_apigatewayv2_api.dev[0].id
  route_key = "$default"
  target    = "integrations/${aws_apigatewayv2_integration.dev_api[0].id}"
}

resource "aws_apigatewayv2_stage" "dev_default" {
  count       = local.dev ? 1 : 0
  api_id      = aws_apigatewayv2_api.dev[0].id
  name        = "$default"
  auto_deploy = true

  default_route_settings {
    throttling_rate_limit  = 10
    throttling_burst_limit = 20
  }
}

# ---------------------------------------------------------------------------
# GitHub deploys to dev from any branch, with rights over dev resources only.
# ---------------------------------------------------------------------------

data "aws_iam_policy_document" "github_dev_assume" {
  count = local.dev ? 1 : 0
  statement {
    actions = ["sts:AssumeRoleWithWebIdentity"]
    principals {
      type        = "Federated"
      identifiers = [local.github_oidc_provider_arn]
    }
    condition {
      test     = "StringEquals"
      variable = "token.actions.githubusercontent.com:aud"
      values   = ["sts.amazonaws.com"]
    }
    condition {
      test     = "StringLike"
      variable = "token.actions.githubusercontent.com:sub"
      values   = ["${var.github_oidc_subject_prefix}:ref:refs/heads/*"]
    }
  }
}

resource "aws_iam_role" "github_deploy_dev" {
  count              = local.dev ? 1 : 0
  name               = "${local.dev_name}-github-deploy"
  assume_role_policy = data.aws_iam_policy_document.github_dev_assume[0].json
}

data "aws_iam_policy_document" "github_deploy_dev" {
  count = local.dev ? 1 : 0

  statement {
    sid       = "EcrLogin"
    actions   = ["ecr:GetAuthorizationToken"]
    resources = ["*"]
  }
  statement {
    sid = "PushImage"
    actions = [
      "ecr:BatchCheckLayerAvailability", "ecr:BatchGetImage", "ecr:CompleteLayerUpload", "ecr:DescribeImages",
      "ecr:GetDownloadUrlForLayer", "ecr:InitiateLayerUpload", "ecr:PutImage", "ecr:UploadLayerPart",
    ]
    resources = [aws_ecr_repository.app.arn]
  }
  statement {
    sid       = "TaskDefinitions"
    actions   = ["ecs:RegisterTaskDefinition", "ecs:DescribeTaskDefinition"]
    resources = ["*"]
  }
  statement {
    sid       = "UpdateDevService"
    actions   = ["ecs:UpdateService", "ecs:DescribeServices"]
    resources = [aws_ecs_service.dev_api[0].id]
  }
  statement {
    sid     = "RunDevTasks"
    actions = ["ecs:RunTask"]
    resources = [
      "${local.task_definition_arn_prefix}/${local.dev_name}-migrate:*",
      "${local.task_definition_arn_prefix}/${local.dev_name}-seed:*",
    ]
    condition {
      test     = "ArnEquals"
      variable = "ecs:cluster"
      values   = [aws_ecs_cluster.main.arn]
    }
  }
  statement {
    sid       = "WatchTasks"
    actions   = ["ecs:DescribeTasks", "ecs:StopTask"]
    resources = ["arn:${local.partition}:ecs:${var.region}:${local.account_id}:task/${aws_ecs_cluster.main.name}/*"]
  }
  statement {
    sid       = "PassDevRoles"
    actions   = ["iam:PassRole"]
    resources = [aws_iam_role.dev_execution[0].arn, aws_iam_role.dev_task[0].arn]
    condition {
      test     = "StringEquals"
      variable = "iam:PassedToService"
      values   = ["ecs-tasks.amazonaws.com"]
    }
  }
}

resource "aws_iam_role_policy" "github_deploy_dev" {
  count  = local.dev ? 1 : 0
  name   = "deploy-dev"
  role   = aws_iam_role.github_deploy_dev[0].id
  policy = data.aws_iam_policy_document.github_deploy_dev[0].json
}

# ---------------------------------------------------------------------------
# Outputs
# ---------------------------------------------------------------------------

output "dev_api_url" {
  description = "Dev API address. The app's dev build uses this plus /api/v1."
  value       = local.dev ? "${aws_apigatewayv2_api.dev[0].api_endpoint}/api/v1" : ""
}

output "dev_documents_bucket" {
  value = local.dev ? local.dev_bucket_name : ""
}

output "dev_github_actions_variables" {
  description = "Repository variables for the Deploy to AWS (dev) workflow."
  value = local.dev ? {
    DEV_AWS_DEPLOY_ROLE_ARN = aws_iam_role.github_deploy_dev[0].arn
    DEV_ECS_API_SERVICE     = aws_ecs_service.dev_api[0].name
    DEV_ECS_API_FAMILY      = aws_ecs_task_definition.dev_api[0].family
    DEV_ECS_MIGRATE_FAMILY  = aws_ecs_task_definition.dev_migrate[0].family
    DEV_ECS_SEED_FAMILY     = aws_ecs_task_definition.dev_seed[0].family
    DEV_API_HEALTH_URL      = "${aws_apigatewayv2_api.dev[0].api_endpoint}/healthz"
  } : {}
}
