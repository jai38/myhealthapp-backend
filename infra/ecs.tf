# ECS Fargate on ARM. One image serves three jobs; only the command differs:
#   api     : node dist/index.js        (image default)
#   worker  : node dist/worker.js
#   migrate : prisma migrate deploy     (one-shot task, run by the deploy workflow before the API updates)

resource "aws_ecs_cluster" "main" {
  name = local.name

  setting {
    name  = "containerInsights"
    value = "disabled" # enabling it adds per-metric charges
  }
}

resource "aws_cloudwatch_log_group" "api" {
  name              = "/ecs/${local.name}/api"
  retention_in_days = var.log_retention_days
}

resource "aws_cloudwatch_log_group" "worker" {
  name              = "/ecs/${local.name}/worker"
  retention_in_days = var.log_retention_days
}

resource "aws_cloudwatch_log_group" "migrate" {
  name              = "/ecs/${local.name}/migrate"
  retention_in_days = var.log_retention_days
}

locals {
  image = "${aws_ecr_repository.app.repository_url}:${var.bootstrap_image_tag}"

  secret_arn = { for name, p in aws_ssm_parameter.secret : name => p.arn }

  api_environment = concat(
    [
      { name = "NODE_ENV", value = "production" },
      { name = "PORT", value = tostring(local.api_container_port) },
      { name = "API_PREFIX", value = "/api/v1" },
      { name = "AWS_REGION", value = var.region },
      { name = "AUTH_PROVIDER", value = "node-internal" },
      { name = "JWT_EXPIRES_IN", value = "7d" },
      { name = "CLIENT_URL", value = var.client_url },
      { name = "APP_BASE_URL", value = var.app_base_url },
      { name = "EMAIL_VERIFICATION_REQUIRED", value = tostring(var.email_verification_required) },
      { name = "DB_CONNECTION_LIMIT", value = tostring(var.db_connection_limit) },
      { name = "STORAGE_BUCKET", value = aws_s3_bucket.documents.bucket },
      { name = "STORAGE_REGION", value = var.region },
      { name = "EXTRACTION_MODE", value = "sqs" },
      { name = "EXTRACTION_JOBS_QUEUE_URL", value = aws_sqs_queue.jobs.url },
      { name = "EXTRACTION_RESULTS_QUEUE_URL", value = aws_sqs_queue.results.url },
      # No AI_EXTRACTION_PROVIDER or AI_PROVIDER_APPROVED here: in queue mode the API never calls the provider.
      # Only the worker does, and the worker enforces the approval gate. Setting provider=gemini with approval
      # off makes validateProductionConfig refuse to start the API.
      { name = "GEMINI_MODEL", value = var.gemini_model },
      { name = "APP_MIN_VERSION", value = var.app_min_version },
      { name = "APP_LATEST_VERSION", value = var.app_latest_version },
      { name = "APP_MAINTENANCE", value = tostring(var.app_maintenance) },
    ],
    var.app_maintenance_message != "" ? [
      { name = "APP_MAINTENANCE_MESSAGE", value = var.app_maintenance_message },
    ] : [],
    var.ses_identity != "" && var.email_from != "" ? [
      { name = "EMAIL_PROVIDER", value = "ses" },
      { name = "EMAIL_FROM", value = var.email_from },
      { name = "SES_REGION", value = var.region },
    ] : [],
  )

  worker_environment = [
    { name = "NODE_ENV", value = "production" },
    { name = "AWS_REGION", value = var.region },
    { name = "STORAGE_BUCKET", value = aws_s3_bucket.documents.bucket },
    { name = "STORAGE_REGION", value = var.region },
    { name = "EXTRACTION_JOBS_QUEUE_URL", value = aws_sqs_queue.jobs.url },
    { name = "EXTRACTION_RESULTS_QUEUE_URL", value = aws_sqs_queue.results.url },
    { name = "GEMINI_MODEL", value = var.gemini_model },
    { name = "AI_PROVIDER_APPROVED", value = tostring(var.ai_provider_approved) },
    { name = "WORKER_PROCESSING_TIMEOUT_MS", value = tostring(var.worker_processing_timeout_ms) },
  ]
}

# ---------------------------------------------------------------------------
# Task definitions
# ---------------------------------------------------------------------------

resource "aws_ecs_task_definition" "api" {
  family                   = "${local.name}-api"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = var.api_cpu
  memory                   = var.api_memory
  execution_role_arn       = aws_iam_role.execution["api"].arn
  task_role_arn            = aws_iam_role.api_task.arn

  runtime_platform {
    cpu_architecture        = "ARM64"
    operating_system_family = "LINUX"
  }

  container_definitions = jsonencode([{
    name      = "api"
    image     = local.image
    essential = true

    portMappings = [{ containerPort = local.api_container_port, protocol = "tcp" }]
    environment  = local.api_environment
    secrets = [
      { name = "DATABASE_URL", valueFrom = local.secret_arn["DATABASE_URL"] },
      { name = "JWT_SECRET", valueFrom = local.secret_arn["JWT_SECRET"] },
    ]

    healthCheck = {
      command     = ["CMD-SHELL", "wget -q -O /dev/null http://127.0.0.1:${local.api_container_port}/healthz || exit 1"]
      interval    = 30
      timeout     = 5
      retries     = 3
      startPeriod = 30
    }

    stopTimeout = 30

    logConfiguration = {
      logDriver = "awslogs"
      options = {
        "awslogs-group"         = aws_cloudwatch_log_group.api.name
        "awslogs-region"        = var.region
        "awslogs-stream-prefix" = "api"
      }
    }
  }])
}

resource "aws_ecs_task_definition" "worker" {
  family                   = "${local.name}-worker"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = var.worker_cpu
  memory                   = var.worker_memory
  execution_role_arn       = aws_iam_role.execution["worker"].arn
  task_role_arn            = aws_iam_role.worker_task.arn

  runtime_platform {
    cpu_architecture        = "ARM64"
    operating_system_family = "LINUX"
  }

  container_definitions = jsonencode([{
    name      = "worker"
    image     = local.image
    essential = true
    command   = ["node", "dist/worker.js"]

    environment = local.worker_environment
    secrets = [
      { name = "GEMINI_API_KEY", valueFrom = local.secret_arn["GEMINI_API_KEY"] },
    ]

    # Time to finish the document in hand after a stop request (Fargate allows up to 120).
    stopTimeout = 90

    logConfiguration = {
      logDriver = "awslogs"
      options = {
        "awslogs-group"         = aws_cloudwatch_log_group.worker.name
        "awslogs-region"        = var.region
        "awslogs-stream-prefix" = "worker"
      }
    }
  }])
}

# One-shot. Holds the database URL and nothing else; no task role.
resource "aws_ecs_task_definition" "migrate" {
  family                   = "${local.name}-migrate"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = 256
  memory                   = 512
  execution_role_arn       = aws_iam_role.execution["migrate"].arn

  runtime_platform {
    cpu_architecture        = "ARM64"
    operating_system_family = "LINUX"
  }

  container_definitions = jsonencode([{
    name      = "migrate"
    image     = local.image
    essential = true
    command   = ["prisma", "migrate", "deploy"]

    secrets = [
      { name = "DATABASE_URL", valueFrom = local.secret_arn["DATABASE_URL"] },
    ]

    logConfiguration = {
      logDriver = "awslogs"
      options = {
        "awslogs-group"         = aws_cloudwatch_log_group.migrate.name
        "awslogs-region"        = var.region
        "awslogs-stream-prefix" = "migrate"
      }
    }
  }])
}

# ---------------------------------------------------------------------------
# Service discovery: API Gateway finds the API task through Cloud Map.
# ---------------------------------------------------------------------------

resource "aws_service_discovery_private_dns_namespace" "main" {
  name = "${local.name}.internal"
  vpc  = aws_vpc.main.id
}

resource "aws_service_discovery_service" "api" {
  name = "api"

  # Lets Terraform replace or remove the service while ECS still has tasks registered in it.
  force_destroy = true

  dns_config {
    namespace_id   = aws_service_discovery_private_dns_namespace.main.id
    routing_policy = "MULTIVALUE"

    # SRV, not A: API Gateway reads the port from the Cloud Map instance, and ECS records it only for SRV.
    # With A records the private integration has no port and every request returns 500.
    dns_records {
      type = "SRV"
      ttl  = 10
    }
  }
}

# ---------------------------------------------------------------------------
# Services. The deploy workflow registers new task definition revisions, so Terraform
# leaves the task definition alone after the first apply.
# ---------------------------------------------------------------------------

resource "aws_ecs_service" "api" {
  name            = "api"
  cluster         = aws_ecs_cluster.main.id
  task_definition = aws_ecs_task_definition.api.arn
  desired_count   = var.api_desired_count
  launch_type     = "FARGATE"

  deployment_minimum_healthy_percent = 100
  deployment_maximum_percent         = 200

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
    registry_arn   = aws_service_discovery_service.api.arn
    container_name = "api"
    container_port = local.api_container_port
  }

  lifecycle {
    ignore_changes = [task_definition]
  }
}

# Desired count starts at 0 and is driven by queue depth (see monitoring.tf).
resource "aws_ecs_service" "worker" {
  name            = "worker"
  cluster         = aws_ecs_cluster.main.id
  task_definition = aws_ecs_task_definition.worker.arn
  desired_count   = 0
  launch_type     = "FARGATE"

  network_configuration {
    subnets          = aws_subnet.public[*].id
    security_groups  = [aws_security_group.worker.id]
    assign_public_ip = true
  }

  lifecycle {
    ignore_changes = [task_definition, desired_count]
  }
}

resource "aws_appautoscaling_target" "worker" {
  service_namespace  = "ecs"
  scalable_dimension = "ecs:service:DesiredCount"
  resource_id        = "service/${aws_ecs_cluster.main.name}/${aws_ecs_service.worker.name}"
  min_capacity       = 0
  max_capacity       = var.worker_max_count
}
