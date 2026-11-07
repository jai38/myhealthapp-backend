<#
.SYNOPSIS
  Day-to-day control of the dev copy on the shared AWS account. Run by the owner, signed in with SSO.

.EXAMPLE
  $env:AWS_PROFILE = 'AdministratorAccess-<account-id>'; aws sso login
  ./dev-env.ps1 Status
  ./dev-env.ps1 SetSecrets         # once, after the first apply with dev_enabled = true
  ./dev-env.ps1 Migrate            # create or update the dev schema
  ./dev-env.ps1 Seed -Users 60     # reset and reseed synthetic data (dev only; refuses prod)
  ./dev-env.ps1 UploadImages -Dir C:\path\to\images   # HW-01.png ... HW-20.png, then Seed again
  ./dev-env.ps1 Stop               # dev API to 0 tasks: stops its cost, keeps the data
  ./dev-env.ps1 Start
  ./dev-env.ps1 Remove             # delete seeded accounts only

  Run from myhealthapp-backend/infra. Names come from Terraform outputs; nothing here touches prod.
#>
param(
  [Parameter(Mandatory = $true, Position = 0)]
  [ValidateSet('Status', 'Start', 'Stop', 'SetSecrets', 'Migrate', 'Seed', 'Remove', 'UploadImages')]
  [string]$Command,
  [int]$Users = 60,
  [string]$Dir
)

$ErrorActionPreference = 'Stop'
$region = 'ap-south-1'
$cluster = 'myhealth-v1'
$service = 'api-dev'
$prefix = '/myhealth/v1'

function Get-Output([string]$name) { terraform output -raw $name }

function Invoke-DevTask([string]$family, [string[]]$command) {
  $vars = terraform output -json github_actions_variables | ConvertFrom-Json
  $network = "awsvpcConfiguration={subnets=[$($vars.MIGRATE_SUBNETS)],securityGroups=[$($vars.MIGRATE_SECURITY_GROUP)],assignPublicIp=ENABLED}"
  $name = if ($family -like '*-seed') { 'seed' } else { 'migrate' }
  $awsArgs = @('ecs', 'run-task', '--region', $region, '--cluster', $cluster, '--launch-type', 'FARGATE', '--task-definition', $family, '--network-configuration', $network, '--query', 'tasks[0].taskArn', '--output', 'text')
  if ($command) {
    $overrides = @{ containerOverrides = @(@{ name = $name; command = $command }) } | ConvertTo-Json -Depth 5 -Compress
    $file = Join-Path $env:TEMP 'dev-task-overrides.json'
    [IO.File]::WriteAllText($file, $overrides)
    $awsArgs += @('--overrides', "file://$file")
  }
  $arn = aws @awsArgs
  Write-Host "Started $family; waiting..."
  aws ecs wait tasks-stopped --region $region --cluster $cluster --tasks $arn
  $code = aws ecs describe-tasks --region $region --cluster $cluster --tasks $arn --query 'tasks[0].containers[0].exitCode' --output text
  if ($code -ne '0') { throw "$family failed (exit $code). Log group: /ecs/myhealth-v1-dev/$name" }
  Write-Host "$family finished."
}

switch ($Command) {
  'Status' {
    aws ecs describe-services --region $region --cluster $cluster --services $service --query 'services[0].{desired:desiredCount,running:runningCount,taskDefinition:taskDefinition}' --output table
    $url = Get-Output 'dev_api_url'
    Write-Host "Dev API: $url"
    try { (Invoke-WebRequest -UseBasicParsing ($url -replace '/api/v1$', '/healthz')).Content } catch { Write-Host 'Dev API not answering (stopped or starting).' }
  }
  'Start' {
    aws ecs update-service --region $region --cluster $cluster --service $service --desired-count 1 | Out-Null
    Write-Host 'Dev API starting (about 1-2 minutes).'
  }
  'Stop' {
    aws ecs update-service --region $region --cluster $cluster --service $service --desired-count 0 | Out-Null
    Write-Host 'Dev API stopped. Data is kept. Note: terraform apply resets the count to dev_api_desired_count.'
  }
  'SetSecrets' {
    # Dev uses the same database server and login as prod, on its own schema. The URL is built from prod's
    # without ever printing it.
    $prodUrl = aws ssm get-parameter --region $region --name "$prefix/DATABASE_URL" --with-decryption --query Parameter.Value --output text
    if ($prodUrl -notmatch 'schema=public') { throw 'Prod DATABASE_URL has no schema=public; set the dev URL by hand.' }
    $devUrl = $prodUrl -replace 'schema=public', 'schema=dev'
    aws ssm put-parameter --region $region --name "$prefix/dev/DATABASE_URL" --type SecureString --key-id alias/myhealth-v1-data --overwrite --value $devUrl | Out-Null
    Remove-Variable prodUrl, devUrl

    $bytes = New-Object byte[] 32
    [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
    aws ssm put-parameter --region $region --name "$prefix/dev/JWT_SECRET" --type SecureString --key-id alias/myhealth-v1-data --overwrite --value ([BitConverter]::ToString($bytes).Replace('-', '')) | Out-Null

    $pw = [Runtime.InteropServices.Marshal]::PtrToStringAuto([Runtime.InteropServices.Marshal]::SecureStringToBSTR((Read-Host -AsSecureString 'Password for all seeded dev accounts (12+ characters)')))
    if ($pw.Length -lt 12) { throw 'Seed password must be 12+ characters.' }
    aws ssm put-parameter --region $region --name "$prefix/dev/SEED_USER_PASSWORD" --type SecureString --key-id alias/myhealth-v1-data --overwrite --value $pw | Out-Null
    Remove-Variable pw
    Write-Host 'Dev secrets set. Restart the dev API (Stop, then Start) if it was already running.'
  }
  'Migrate' { Invoke-DevTask 'myhealth-v1-dev-migrate' $null }
  'Seed' { Invoke-DevTask 'myhealth-v1-dev-seed' @('node', 'dist/scripts/seed-dev/index.js', '--target', 'dev', '--reset', '--users', "$Users") }
  'Remove' { Invoke-DevTask 'myhealth-v1-dev-seed' @('node', 'dist/scripts/seed-dev/index.js', '--target', 'dev', '--remove') }
  'UploadImages' {
    if (-not $Dir) { throw 'Pass -Dir with HW-01.png ... HW-20.png' }
    $bucket = Get-Output 'dev_documents_bucket'
    if ($bucket -notmatch '-dev-') { throw "Refusing: $bucket is not the dev bucket." }
    Get-ChildItem $Dir -File | Where-Object { $_.Name -match '^HW-\d{2}\.(png|jpe?g)$' } | ForEach-Object {
      aws s3 cp $_.FullName "s3://$bucket/seed-assets/$($_.Name)" --region $region | Out-Null
      Write-Host "Uploaded $($_.Name)"
    }
    Write-Host 'Now run: ./dev-env.ps1 Seed'
  }
}
