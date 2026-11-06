# ---------------------------------------------------------------------------
# Identity
# ---------------------------------------------------------------------------

variable "project" {
  description = "Short name used as a prefix on every resource."
  type        = string
  default     = "myhealth"
}

variable "environment" {
  description = "Environment name, for example v1 or test. Part of every resource name."
  type        = string

  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{1,14}$", var.environment))
    error_message = "environment must be 2-15 characters: lowercase letters, digits and hyphens, starting with a letter."
  }
}

variable "region" {
  description = "AWS region. Mumbai keeps data in India."
  type        = string
  default     = "ap-south-1"
}

# ---------------------------------------------------------------------------
# Network
# ---------------------------------------------------------------------------

variable "vpc_cidr" {
  description = "CIDR block of the VPC."
  type        = string
  default     = "10.20.0.0/16"
}

# ---------------------------------------------------------------------------
# API service
# ---------------------------------------------------------------------------

variable "api_cpu" {
  description = "API task CPU units (256 = 0.25 vCPU)."
  type        = number
  default     = 256
}

variable "api_memory" {
  description = "API task memory in MiB."
  type        = number
  default     = 512
}

variable "api_desired_count" {
  description = "Number of API tasks. More than one is safe: the API is stateless."
  type        = number
  default     = 1
}

variable "db_connection_limit" {
  description = "Prisma connection pool size per task. Keep (API tasks + 1 migration task) x this below the database max_connections."
  type        = number
  default     = 5
}

variable "bootstrap_image_tag" {
  description = "Image tag the first task definitions point at. The deploy workflow replaces it with a commit tag."
  type        = string
  default     = "bootstrap"
}

variable "api_throttle_rate" {
  description = "API Gateway steady-state requests per second for the whole API."
  type        = number
  default     = 25
}

variable "api_throttle_burst" {
  description = "API Gateway burst limit."
  type        = number
  default     = 50
}

# ---------------------------------------------------------------------------
# Worker
# ---------------------------------------------------------------------------

variable "worker_cpu" {
  description = "Worker task CPU units."
  type        = number
  default     = 256
}

variable "worker_memory" {
  description = "Worker task memory in MiB."
  type        = number
  default     = 512
}

variable "worker_max_count" {
  description = "Most worker tasks that queue depth may start. The worker sits at 0 when idle."
  type        = number
  default     = 1
}

variable "worker_idle_minutes_before_scale_in" {
  description = "Minutes with an empty queue and nothing in flight before the worker is stopped."
  type        = number
  default     = 10
}

variable "worker_processing_timeout_ms" {
  description = "How long the worker waits for the AI provider on one document."
  type        = number
  default     = 60000
}

# ---------------------------------------------------------------------------
# Database
# ---------------------------------------------------------------------------

variable "db_instance_class" {
  description = "RDS instance class."
  type        = string
  default     = "db.t4g.micro"
}

variable "db_allocated_storage" {
  description = "Database storage in GB."
  type        = number
  default     = 20
}

variable "db_max_allocated_storage" {
  description = "Upper bound for automatic storage growth in GB. 0 turns growth off."
  type        = number
  default     = 0
}

variable "db_engine_version" {
  description = "PostgreSQL version. A major version alone follows the latest minor."
  type        = string
  default     = "16"
}

variable "db_multi_az" {
  description = "Standby in a second zone. Doubles the database price."
  type        = bool
  default     = false
}

variable "db_backup_retention_days" {
  description = "Days of automated backups (point-in-time restore window)."
  type        = number
  default     = 7
}

variable "db_deletion_protection" {
  description = "Refuse to delete the database through the API or Terraform."
  type        = bool
  default     = true
}

variable "db_skip_final_snapshot" {
  description = "Skip the final snapshot on destroy. Keep false for anything with real data."
  type        = bool
  default     = false
}

# ---------------------------------------------------------------------------
# Storage
# ---------------------------------------------------------------------------

variable "documents_bucket_name" {
  description = "Override for the document bucket name. Empty builds <project>-<env>-documents-<account id>."
  type        = string
  default     = ""
}

variable "documents_force_destroy" {
  description = "Allow Terraform to delete the bucket with documents in it. Only for the temporary test copy."
  type        = bool
  default     = false
}

variable "documents_noncurrent_days" {
  description = "Days an overwritten or deleted version is kept. Short on purpose: account erasure removes current versions only."
  type        = number
  default     = 1
}

variable "web_origins" {
  description = "Browser origins allowed to upload to and read from the bucket with signed links (the web app)."
  type        = list(string)
  default     = ["https://jai38.github.io"]
}

# ---------------------------------------------------------------------------
# Application settings
# ---------------------------------------------------------------------------

variable "client_url" {
  description = "Allowed browser origin for the API (CORS). A single origin; never *."
  type        = string
  default     = "https://jai38.github.io"
}

variable "app_base_url" {
  description = "Base URL used in emailed links (verify email, reset password)."
  type        = string
  default     = "https://jai38.github.io/myhealthapp"
}

variable "gemini_model" {
  description = "Gemini model name used by the worker."
  type        = string
  default     = "gemini-3.5-flash-lite"
}

variable "ai_provider_approved" {
  description = "Set true only after the AI provider terms are verified. The worker refuses to start in production while this is false."
  type        = bool
  default     = false
}

variable "email_verification_required" {
  description = "Require email verification on signup. Keep false until the app has verification screens (Phase 5)."
  type        = bool
  default     = false
}

# App status (GET /api/v1/app-status). The API refuses to start if a version is not x.y.z,
# or if the minimum is above the latest, so a bad value fails the deploy, not the patient.
variable "app_min_version" {
  description = "Lowest app version allowed to run. Raise it only when a real store listing exists."
  type        = string
  default     = "1.0.0"
  validation {
    condition     = can(regex("^[0-9]+\\.[0-9]+\\.[0-9]+$", var.app_min_version))
    error_message = "app_min_version must be x.y.z."
  }
}

variable "app_latest_version" {
  description = "Newest app version. Apps below it see a dismissible update card."
  type        = string
  default     = "1.0.0"
  validation {
    condition     = can(regex("^[0-9]+\\.[0-9]+\\.[0-9]+$", var.app_latest_version))
    error_message = "app_latest_version must be x.y.z."
  }
}

variable "app_maintenance" {
  description = "Show the maintenance screen to every app."
  type        = bool
  default     = false
}

variable "app_maintenance_message" {
  description = "Optional maintenance text. Leave empty to leave the setting unset (a blank value is never sent)."
  type        = string
  default     = ""
}

variable "email_from" {
  description = "Sender address for account emails. Must belong to the SES identity."
  type        = string
  default     = ""
}

variable "ses_identity" {
  description = "Domain or email address to verify in SES. Empty skips creating one."
  type        = string
  default     = ""
}

# ---------------------------------------------------------------------------
# API entry
# ---------------------------------------------------------------------------

variable "custom_domain_name" {
  description = "Custom domain for the API, for example api.example.org. Empty uses the default execute-api URL."
  type        = string
  default     = ""
}

variable "acm_certificate_arn" {
  description = "ARN of an issued ACM certificate in the same region for custom_domain_name."
  type        = string
  default     = ""
}

# ---------------------------------------------------------------------------
# Monitoring and cost
# ---------------------------------------------------------------------------

variable "log_retention_days" {
  description = "CloudWatch log retention."
  type        = number
  default     = 14
}

variable "alert_email" {
  description = "Address that receives budget and alarm emails. Each address must confirm the subscription."
  type        = string

  validation {
    condition     = can(regex("^[^@ ]+@[^@ ]+[.][^@ ]+$", var.alert_email)) && !endswith(var.alert_email, "@example.com")
    error_message = "alert_email must be a real email address. Replace the placeholder in the tfvars file."
  }
}

variable "budget_monthly_usd" {
  description = "Monthly cost budget in USD. Alerts at 80 percent actual and 100 percent forecast."
  type        = number
  default     = 60
}

# ---------------------------------------------------------------------------
# GitHub deploy role
# ---------------------------------------------------------------------------

variable "github_oidc_subject_prefix" {
  description = "Subject prefix GitHub puts in the OIDC token for the repository allowed to deploy, without the ':ref:...' part. The repository uses immutable subjects (owner and repository ids), so a renamed or recreated repository cannot assume the role. Read it with: gh api repos/<owner>/<repo>/actions/oidc/customization/sub"
  type        = string
  default     = "repo:jai38@71269258/myhealthapp-backend@1415279162"

  validation {
    condition     = startswith(var.github_oidc_subject_prefix, "repo:") && !strcontains(var.github_oidc_subject_prefix, ":ref:")
    error_message = "github_oidc_subject_prefix must start with 'repo:' and must not include the ':ref:' part."
  }
}

variable "github_allowed_refs" {
  description = "Git refs allowed to assume the deploy role."
  type        = list(string)
  default     = ["refs/heads/main"]
}

variable "create_github_oidc_provider" {
  description = "Create the GitHub OIDC provider. It exists once per AWS account: set false for a second environment."
  type        = bool
  default     = true
}
