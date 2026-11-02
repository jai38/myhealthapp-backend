output "api_url" {
  description = "Default API address. Use this until a custom domain is set."
  value       = aws_apigatewayv2_api.main.api_endpoint
}

output "api_health_url" {
  description = "Value for the API_HEALTH_URL repository variable."
  value       = "${aws_apigatewayv2_api.main.api_endpoint}/healthz"
}

output "custom_domain_target" {
  description = "Point a CNAME for custom_domain_name at this name. Empty when no custom domain is set."
  value       = var.custom_domain_name != "" ? aws_apigatewayv2_domain_name.custom[0].domain_name_configuration[0].target_domain_name : ""
}

output "github_deploy_role_arn" {
  description = "Value for the AWS_DEPLOY_ROLE_ARN repository variable."
  value       = aws_iam_role.github_deploy.arn
}

output "github_actions_variables" {
  description = "Every repository variable the deploy workflow reads, ready to copy."
  value = {
    AWS_REGION             = var.region
    AWS_DEPLOY_ROLE_ARN    = aws_iam_role.github_deploy.arn
    ECR_REPOSITORY         = aws_ecr_repository.app.name
    ECS_CLUSTER            = aws_ecs_cluster.main.name
    ECS_API_SERVICE        = aws_ecs_service.api.name
    ECS_WORKER_SERVICE     = aws_ecs_service.worker.name
    ECS_API_FAMILY         = aws_ecs_task_definition.api.family
    ECS_WORKER_FAMILY      = aws_ecs_task_definition.worker.family
    ECS_MIGRATE_FAMILY     = aws_ecs_task_definition.migrate.family
    MIGRATE_SUBNETS        = join(",", aws_subnet.public[*].id)
    MIGRATE_SECURITY_GROUP = aws_security_group.api.id
    API_HEALTH_URL         = "${aws_apigatewayv2_api.main.api_endpoint}/healthz"
  }
}

output "database_endpoint" {
  description = "Host name for DATABASE_URL."
  value       = aws_db_instance.main.address
}

output "database_name" {
  value = aws_db_instance.main.db_name
}

output "database_username" {
  value = aws_db_instance.main.username
}

output "database_identifier" {
  description = "Used with aws rds modify-db-instance to set the real password."
  value       = aws_db_instance.main.identifier
}

output "parameter_names" {
  description = "Parameter Store entries the owner fills in."
  value       = { for name, p in aws_ssm_parameter.secret : name => p.name }
}

output "documents_bucket" {
  value = aws_s3_bucket.documents.bucket
}

output "extraction_jobs_queue_url" {
  value = aws_sqs_queue.jobs.url
}

output "extraction_results_queue_url" {
  value = aws_sqs_queue.results.url
}

output "ses_dkim_tokens" {
  description = "Create a CNAME <token>._domainkey.<domain> -> <token>.dkim.amazonses.com for each, when the identity is a domain."
  value       = var.ses_identity != "" ? aws_sesv2_email_identity.main[0].dkim_signing_attributes[0].tokens : []
}
