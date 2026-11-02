# AWS infrastructure (Phase 2)

Terraform for one lean environment in Mumbai (`ap-south-1`). Everything is code; sizes are variables in `envs/*.tfvars`.

> **Status: v1 is live** (applied 2 November 2026, account `768666230063`, `ap-south-1`). Steps 1-10 are done; the AI worker stays off until step 11. Always read a plan before applying it, and do not apply a plan that destroys anything you did not expect.
>
> **Account notes.** The organization's root SCP `AdvancedModeRegionRestrictionSecurityControlPolicy` allows only listed regions; `ap-south-1` was added to its `RegionFloor` list. Sign in with the SSO profile (step 1): `~/.aws/credentials` holds an old static `[default]` key that AWS rejects.

## What it builds

```
App ──HTTPS──> API Gateway (HTTP API) ──VPC link──> Cloud Map ──> ECS Fargate API task (ARM, 0.25 vCPU / 0.5 GB, public IP)
                                                                    │ SG: only the VPC link may connect
                                                                    ├──> RDS PostgreSQL 16 (db.t4g.micro, 20 GB, encrypted, private subnets)
                                                                    ├──> S3 documents (private, versioned, SSE-KMS + bucket key)
                                                                    └──> SQS jobs ──> Worker task (ARM, runs only when jobs wait) ──> SQS results ──> API
```

- No NAT gateway. Tasks sit in public subnets with public IPs; security groups allow in only what is listed above.
- The database is in subnets with no internet route and is not publicly accessible.
- The worker has no database credentials: it reads a job from SQS, reads the document from S3, calls Gemini, and returns the result on a second queue. The API records the result.
- Secrets live in Parameter Store (`SecureString`, encrypted with the project key). Terraform creates them with the placeholder `REPLACE_ME_BY_OWNER` and ignores later changes.
- A one-shot `migrate` task definition runs `prisma migrate deploy`. The API container no longer migrates on start.

| File | Contents |
|---|---|
| `network.tf` | VPC, subnets, security groups, S3 gateway endpoint |
| `data.tf` | KMS key, ECR, S3, SQS and dead-letter queues, Parameter Store, RDS |
| `iam.tf` | Execution and task roles, one set per task |
| `ecs.tf` | Cluster, task definitions (api, worker, migrate), services, Cloud Map |
| `entry.tf` | API Gateway, VPC link, optional custom domain, SES identity |
| `monitoring.tf` | Worker scaling, dead-letter and storage alarms, budget |
| `github.tf` | GitHub OIDC provider and deploy role |
| `envs/v1.tfvars`, `envs/test.tfvars` | Values per environment |

## Your steps, in order

Commands are PowerShell. Run them from `myhealthapp-backend/infra` unless a step says otherwise. Use an AWS profile for your own admin user with MFA; no model or CI holds AWS keys.

### 1. Check tools and identity

Sign in through IAM Identity Center (SSO) and point both the AWS CLI and Terraform at that profile. Do this in every new PowerShell window; the sign-in lasts a few hours.

```powershell
$env:AWS_PROFILE = 'AdministratorAccess-<account-id>'   # name from: aws configure list-profiles
aws sso login
terraform version          # needs 1.6 or newer
aws sts get-caller-identity
```

The account id printed must be the account you intend to use. If `terraform` is missing, install it first (`winget install Hashicorp.Terraform`).

### 2. Set your email

Edit `envs/v1.tfvars` and replace `CHANGE_ME@example.com` in `alert_email`. Planning fails until you do. Leave `ai_provider_approved = false` for now.

### 3. Initialise, check, plan

```powershell
terraform init
terraform workspace new v1
terraform fmt -recursive
terraform validate
terraform plan -var-file=envs/v1.tfvars -out=v1.tfplan
```

Read the plan. Expect only additions: nothing to change or destroy on a first run. `terraform validate` must say `Success`. Send me any error text.

### 4. Apply

```powershell
terraform apply v1.tfplan
```

This takes about 10 minutes, mostly the database. The API service will show failing tasks until step 9 pushes an image: that is expected.

### 5. Confirm the alert emails

AWS emails the address from step 2 to confirm the SNS subscription. Click the link. Budget alerts need no confirmation.

### 6. Set the real database password

The database was created with a throwaway password that nobody has seen. Replace it with one you generate:

```powershell
$bytes = New-Object byte[] 32
[Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
$dbPassword = [BitConverter]::ToString($bytes).Replace('-','')

aws rds modify-db-instance --region ap-south-1 `
  --db-instance-identifier (terraform output -raw database_identifier) `
  --master-user-password $dbPassword --apply-immediately

aws rds wait db-instance-available --region ap-south-1 `
  --db-instance-identifier (terraform output -raw database_identifier)
```

Keep the PowerShell window open: the next step uses `$dbPassword`.

### 7. Fill in Parameter Store

```powershell
$region = 'ap-south-1'
$key    = 'alias/myhealth-v1-data'
$prefix = '/myhealth/v1'
$dbHost = terraform output -raw database_endpoint

# Database URL. sslmode=require is needed because RDS refuses unencrypted connections.
aws ssm put-parameter --region $region --name "$prefix/DATABASE_URL" --type SecureString --key-id $key --overwrite `
  --value "postgresql://myhealth_admin:$dbPassword@${dbHost}:5432/myhealthapp?schema=public&sslmode=require"

# JWT signing secret (64 random hex characters).
$bytes = New-Object byte[] 32
[Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
aws ssm put-parameter --region $region --name "$prefix/JWT_SECRET" --type SecureString --key-id $key --overwrite `
  --value ([BitConverter]::ToString($bytes).Replace('-',''))

# Gemini key: the NEW paid key from task 2. Typed, so it never enters shell history.
$geminiKey = [Runtime.InteropServices.Marshal]::PtrToStringAuto([Runtime.InteropServices.Marshal]::SecureStringToBSTR((Read-Host -AsSecureString 'Gemini key')))
aws ssm put-parameter --region $region --name "$prefix/GEMINI_API_KEY" --type SecureString --key-id $key --overwrite --value $geminiKey

Remove-Variable dbPassword, geminiKey
```

The API refuses to start while `JWT_SECRET` is a placeholder; that is the safety check working.

### 8. Give GitHub the deploy settings

These are names and ids, not secrets. They become repository **variables** (not secrets). Run from the repo root of `myhealthapp-backend`, signed in with `gh auth login`:

```powershell
cd ..
$vars = terraform -chdir=infra output -json github_actions_variables | ConvertFrom-Json
$vars.PSObject.Properties | ForEach-Object { gh variable set $_.Name --body $_.Value --repo jai38/myhealthapp-backend }
cd infra
```

### 9. First deploy

The deploy workflow (`.github/workflows/deploy-aws.yml`) runs only on request and only from `main`, so the branch has to be merged first:

1. Merge `phase-2/aws` into `main`. (Done 2 November 2026. Before the cutover this also redeployed Render, which has since been retired.)
2. GitHub, **Actions**, **Deploy to AWS (ECS)**, **Run workflow** on `main`.
3. The run builds the ARM image (about 10-15 minutes under emulation), runs the migration task, updates the API and worker, waits for the API to be stable, and checks the health URL.

If the migration step fails, open CloudWatch log group `/ecs/myhealth-v1/migrate`. Nothing else is updated when it fails.

### 10. Check it works

```powershell
curl (terraform output -raw api_health_url)
```

Expect `{"status":"ok", ... "environment":"production"}`. Then point a test build of the app at `terraform output -raw api_url` plus `/api/v1` (`EXPO_PUBLIC_API_URL`), sign up, upload a document, and confirm an extraction. The first extraction after an idle period waits 2-3 minutes while the worker starts; later ones are quick.

### 11. Turn the AI worker on for real

The worker refuses to start in production until `ai_provider_approved = true`. Set it only after the provider terms (data processing agreement, no training on your data, processing location) are verified:

```powershell
# edit envs/v1.tfvars: ai_provider_approved = true
terraform apply -var-file=envs/v1.tfvars
```

Then run the deploy workflow again, because the services keep the task definition revision the workflow registers.

### 12. Email and a custom domain (when ready)

- **SES:** set `ses_identity` (a domain, or one address for a first test) and `email_from` in `envs/v1.tfvars` and apply. For a domain, publish the three DKIM CNAMEs from `terraform output ses_dkim_tokens`. New accounts are in the SES sandbox: request production access in the SES console before sending to real users. Turn `email_verification_required` on only when the app has its verification screens.
- **Custom domain:** request an ACM certificate in `ap-south-1`, set `custom_domain_name` and `acm_certificate_arn`, apply, then create the CNAME from `terraform output custom_domain_target`. Point the app at `https://api.<domain>/api/v1`.

### 13. Temporary test copy (before releases)

```powershell
terraform workspace new test
terraform apply -var-file=envs/test.tfvars     # after editing alert_email there
# ... test, then:
terraform destroy -var-file=envs/test.tfvars
terraform workspace select v1
```

Deploy workflow variables point at v1 only; deploy to the test copy by pointing variables at its outputs temporarily, or test it by hand.

### 14. Saving money while building

Stop the database when idle: `aws rds stop-db-instance --db-instance-identifier myhealth-v1`. AWS starts it again by itself after 7 days. Storage is still billed while stopped.

## State

Terraform state is a local file in `terraform.tfstate.d/`, and it is git-ignored. After step 7, a refresh copies the real parameter values into state, so **the state file holds your secrets**. Treat it like a password file: do not share it and do not put it in the repo. Before real patient data, move state to a private, encrypted S3 bucket with versioning (add a `backend "s3"` block to `versions.tf` and run `terraform init -migrate-state`).

## Rollback and removal

- Bad deploy: re-run the workflow after reverting on `main`, or in ECS point the service at the previous task definition revision.
- Database deletion protection is on. `terraform destroy` of v1 is refused until you set `db_deletion_protection = false` and apply.
- The bucket cannot be destroyed while it holds documents (`documents_force_destroy = false`).

## Decisions worth knowing

- Database password is set by you and never appears in Terraform (RDS-managed passwords rotate weekly and would break the stored connection string).
- The app currently connects as the database owner (`myhealth_admin`). A separate least-privilege application role is a good follow-up.
- Non-current S3 versions expire after 1 day. Account erasure deletes current objects; the short window keeps erased documents from lingering.
- The worker's Gemini key reaches it through its ECS execution role at task start; the worker's runtime role has no Parameter Store access.
