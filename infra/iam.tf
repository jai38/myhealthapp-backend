# Least privilege per task:
#   api     : documents bucket, send jobs, read results, send mail. Database access is by connection string.
#   worker  : read jobs, send results, read documents. No database credentials, no Parameter Store access
#             beyond the Gemini key that ECS injects at start.
#   migrate : no task role at all; its execution role can read the database URL only.

data "aws_iam_policy_document" "ecs_tasks_assume" {
  statement {
    actions = ["sts:AssumeRole"]

    principals {
      type        = "Service"
      identifiers = ["ecs-tasks.amazonaws.com"]
    }

    condition {
      test     = "StringEquals"
      variable = "aws:SourceAccount"
      values   = [local.account_id]
    }
  }
}

# ---------------------------------------------------------------------------
# Execution roles: pull the image, write logs, and inject only that task's secrets.
# ---------------------------------------------------------------------------

locals {
  execution_roles = {
    api = {
      parameters = ["DATABASE_URL", "JWT_SECRET"]
      log_group  = aws_cloudwatch_log_group.api.arn
    }
    worker = {
      parameters = ["GEMINI_API_KEY"]
      log_group  = aws_cloudwatch_log_group.worker.arn
    }
    migrate = {
      parameters = ["DATABASE_URL"]
      log_group  = aws_cloudwatch_log_group.migrate.arn
    }
  }
}

resource "aws_iam_role" "execution" {
  for_each = local.execution_roles

  name               = "${local.name}-${each.key}-execution"
  assume_role_policy = data.aws_iam_policy_document.ecs_tasks_assume.json
}

data "aws_iam_policy_document" "execution" {
  for_each = local.execution_roles

  statement {
    sid       = "EcrLogin"
    actions   = ["ecr:GetAuthorizationToken"]
    resources = ["*"]
  }

  statement {
    sid = "EcrPull"
    actions = [
      "ecr:BatchCheckLayerAvailability",
      "ecr:BatchGetImage",
      "ecr:GetDownloadUrlForLayer",
    ]
    resources = [aws_ecr_repository.app.arn]
  }

  statement {
    sid       = "Logs"
    actions   = ["logs:CreateLogStream", "logs:PutLogEvents"]
    resources = ["${each.value.log_group}:*"]
  }

  statement {
    sid       = "ReadOwnSecrets"
    actions   = ["ssm:GetParameters"]
    resources = [for name in each.value.parameters : aws_ssm_parameter.secret[name].arn]
  }

  statement {
    sid       = "DecryptSecrets"
    actions   = ["kms:Decrypt"]
    resources = [aws_kms_key.data.arn]
  }
}

resource "aws_iam_role_policy" "execution" {
  for_each = local.execution_roles

  name   = "execution"
  role   = aws_iam_role.execution[each.key].id
  policy = data.aws_iam_policy_document.execution[each.key].json
}

# ---------------------------------------------------------------------------
# API task role
# ---------------------------------------------------------------------------

resource "aws_iam_role" "api_task" {
  name               = "${local.name}-api-task"
  assume_role_policy = data.aws_iam_policy_document.ecs_tasks_assume.json
}

data "aws_iam_policy_document" "api_task" {
  statement {
    sid = "DocumentObjects"
    actions = [
      "s3:GetObject",
      "s3:PutObject",
      "s3:DeleteObject",
      "s3:DeleteObjectVersion",
    ]
    resources = ["${aws_s3_bucket.documents.arn}/documents/*"]
  }

  statement {
    sid       = "ListDocuments"
    actions   = ["s3:ListBucket", "s3:ListBucketVersions"]
    resources = [aws_s3_bucket.documents.arn]
  }

  statement {
    sid       = "SendJobs"
    actions   = ["sqs:SendMessage", "sqs:GetQueueAttributes"]
    resources = [aws_sqs_queue.jobs.arn]
  }

  statement {
    sid = "ReadResults"
    actions = [
      "sqs:ReceiveMessage",
      "sqs:DeleteMessage",
      "sqs:ChangeMessageVisibility",
      "sqs:GetQueueAttributes",
    ]
    resources = [aws_sqs_queue.results.arn]
  }

  # S3 and SQS use the key on the caller's behalf, including for signed links the API creates.
  statement {
    sid       = "UseDataKey"
    actions   = ["kms:Decrypt", "kms:GenerateDataKey", "kms:DescribeKey"]
    resources = [aws_kms_key.data.arn]
  }

  dynamic "statement" {
    for_each = var.ses_identity != "" ? [1] : []

    content {
      sid       = "SendMail"
      actions   = ["ses:SendEmail"]
      resources = [aws_sesv2_email_identity.main[0].arn]
    }
  }
}

resource "aws_iam_role_policy" "api_task" {
  name   = "api"
  role   = aws_iam_role.api_task.id
  policy = data.aws_iam_policy_document.api_task.json
}

# ---------------------------------------------------------------------------
# Worker task role
# ---------------------------------------------------------------------------

resource "aws_iam_role" "worker_task" {
  name               = "${local.name}-worker-task"
  assume_role_policy = data.aws_iam_policy_document.ecs_tasks_assume.json
}

data "aws_iam_policy_document" "worker_task" {
  statement {
    sid = "ReadJobs"
    actions = [
      "sqs:ReceiveMessage",
      "sqs:DeleteMessage",
      "sqs:ChangeMessageVisibility",
      "sqs:GetQueueAttributes",
    ]
    resources = [aws_sqs_queue.jobs.arn]
  }

  statement {
    sid       = "ReturnResults"
    actions   = ["sqs:SendMessage"]
    resources = [aws_sqs_queue.results.arn]
  }

  statement {
    sid       = "ReadDocuments"
    actions   = ["s3:GetObject"]
    resources = ["${aws_s3_bucket.documents.arn}/documents/*"]
  }

  statement {
    sid       = "UseDataKey"
    actions   = ["kms:Decrypt", "kms:GenerateDataKey"]
    resources = [aws_kms_key.data.arn]
  }
}

resource "aws_iam_role_policy" "worker_task" {
  name   = "worker"
  role   = aws_iam_role.worker_task.id
  policy = data.aws_iam_policy_document.worker_task.json
}
