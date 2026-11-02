# Temporary copy for pre-release checks. Create it for a few days, then destroy it.
# Same code, smaller safety settings so it can be deleted. Never put real patient data in it.
# Use a separate workspace: terraform workspace new test

environment = "test"
region      = "ap-south-1"

# REQUIRED: replace with your address.
alert_email = "CHANGE_ME@example.com"

vpc_cidr = "10.30.0.0/16" # different range from v1

api_desired_count = 1
worker_max_count  = 1

db_instance_class        = "db.t4g.micro"
db_allocated_storage     = 20
db_backup_retention_days = 1
db_deletion_protection   = false
db_skip_final_snapshot   = true

documents_force_destroy = true

log_retention_days = 3
budget_monthly_usd = 15

ai_provider_approved        = false
email_verification_required = false

# The GitHub OIDC provider exists once per account and is created by the v1 environment.
create_github_oidc_provider = false
github_repository           = "jai38/myhealthapp-backend"
github_allowed_refs         = ["refs/heads/main"]
