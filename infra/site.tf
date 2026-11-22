# Landing page (side track L): the static site from the site repository, served at the apex
# domain and www from a private S3 bucket behind CloudFront. Off until site_domain_name is set.
#
#   bucket     : private, Block Public Access, SSE-S3, versioning; readable only by this
#                distribution through Origin Access Control
#   CloudFront : HTTPS only, TLS 1.2+, HTTP/2 and 3, compression, PriceClass_200 (includes India),
#                security headers, www redirected to the apex by a CloudFront Function
#   ACM        : one certificate in us-east-1 for the apex and www, validated through Route 53
#   Route 53   : A and AAAA aliases in the existing public hosted zone (read, never created here)
#   deploy     : a GitHub OIDC role for the site repository's main branch only, limited to this
#                bucket and one invalidation call on this distribution
#
# Cost: a few US cents a month for S3 and CloudFront at landing-page traffic, plus USD 0.50 a
# month for the hosted zone, which exists already. The certificate is free.

variable "site_domain_name" {
  description = "Apex domain of the landing page, for example example.com. Must match an existing public Route 53 hosted zone. Empty turns the site off."
  type        = string
  default     = ""

  validation {
    condition     = var.site_domain_name == "" || can(regex("^([a-z0-9-]+\\.)+[a-z]{2,}$", var.site_domain_name))
    error_message = "site_domain_name must be a lowercase domain such as example.com, or empty."
  }
}

variable "site_github_oidc_subject_prefix" {
  description = "OIDC subject prefix of the site repository, without ':ref:...'. Immutable form (owner and repository ids), like github_oidc_subject_prefix. Read it with: gh api repos/<owner>/<repo>/actions/oidc/customization/sub"
  type        = string
  default     = "repo:jai38@71269258/MyHealth@1423386444"

  validation {
    condition     = startswith(var.site_github_oidc_subject_prefix, "repo:") && !strcontains(var.site_github_oidc_subject_prefix, ":ref:")
    error_message = "site_github_oidc_subject_prefix must start with 'repo:' and must not include the ':ref:' part."
  }
}

variable "site_content_security_policy" {
  description = "Content-Security-Policy for the landing page. The page has no scripts and loads nothing from other domains. style-src-attr allows the page's inline style attributes (not <style> blocks); drop it once they move into the stylesheet."
  type        = string
  default     = "default-src 'self'; img-src 'self' data:; style-src 'self'; style-src-attr 'unsafe-inline'; font-src 'self'; script-src 'none'; object-src 'none'; base-uri 'self'; form-action 'none'; frame-ancestors 'none'; upgrade-insecure-requests"
}

variable "site_not_found_path" {
  description = "Page served, with status 404, for a path that does not exist."
  type        = string
  default     = "/index.html"
}

locals {
  site         = var.site_domain_name != ""
  site_www     = "www.${var.site_domain_name}"
  site_aliases = [var.site_domain_name, local.site_www]
  site_bucket  = "${local.name}-site-${local.account_id}"
}

# CloudFront only accepts certificates from us-east-1.
provider "aws" {
  alias  = "us_east_1"
  region = "us-east-1"

  default_tags {
    tags = {
      Project     = var.project
      Environment = var.environment
      ManagedBy   = "terraform"
    }
  }
}

data "aws_route53_zone" "site" {
  count        = local.site ? 1 : 0
  name         = var.site_domain_name
  private_zone = false
}

# ---------------------------------------------------------------------------
# Bucket
# ---------------------------------------------------------------------------

resource "aws_s3_bucket" "site" {
  count  = local.site ? 1 : 0
  bucket = local.site_bucket
}

resource "aws_s3_bucket_ownership_controls" "site" {
  count  = local.site ? 1 : 0
  bucket = aws_s3_bucket.site[0].id
  rule {
    object_ownership = "BucketOwnerEnforced"
  }
}

resource "aws_s3_bucket_public_access_block" "site" {
  count                   = local.site ? 1 : 0
  bucket                  = aws_s3_bucket.site[0].id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_server_side_encryption_configuration" "site" {
  count  = local.site ? 1 : 0
  bucket = aws_s3_bucket.site[0].id
  rule {
    # SSE-S3: CloudFront's Origin Access Control reads it with no extra key policy.
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

resource "aws_s3_bucket_versioning" "site" {
  count  = local.site ? 1 : 0
  bucket = aws_s3_bucket.site[0].id
  versioning_configuration {
    status = "Enabled"
  }
}

# Every deploy replaces files; keep old versions 30 days so a bad deploy can be rolled back.
resource "aws_s3_bucket_lifecycle_configuration" "site" {
  count  = local.site ? 1 : 0
  bucket = aws_s3_bucket.site[0].id

  rule {
    id     = "expire-old-versions"
    status = "Enabled"
    filter {}
    noncurrent_version_expiration {
      noncurrent_days = 30
    }
    abort_incomplete_multipart_upload {
      days_after_initiation = 1
    }
  }

  depends_on = [aws_s3_bucket_versioning.site]
}

data "aws_iam_policy_document" "site_bucket" {
  count = local.site ? 1 : 0

  statement {
    sid       = "CloudFrontReadOnly"
    actions   = ["s3:GetObject"]
    resources = ["${aws_s3_bucket.site[0].arn}/*"]

    principals {
      type        = "Service"
      identifiers = ["cloudfront.amazonaws.com"]
    }

    condition {
      test     = "StringEquals"
      variable = "AWS:SourceArn"
      values   = [aws_cloudfront_distribution.site[0].arn]
    }
  }

  statement {
    sid       = "DenyInsecureTransport"
    effect    = "Deny"
    actions   = ["s3:*"]
    resources = [aws_s3_bucket.site[0].arn, "${aws_s3_bucket.site[0].arn}/*"]

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

resource "aws_s3_bucket_policy" "site" {
  count  = local.site ? 1 : 0
  bucket = aws_s3_bucket.site[0].id
  policy = data.aws_iam_policy_document.site_bucket[0].json

  depends_on = [aws_s3_bucket_public_access_block.site]
}

# ---------------------------------------------------------------------------
# Certificate (us-east-1), validated through the hosted zone
# ---------------------------------------------------------------------------

resource "aws_acm_certificate" "site" {
  count                     = local.site ? 1 : 0
  provider                  = aws.us_east_1
  domain_name               = var.site_domain_name
  subject_alternative_names = [local.site_www]
  validation_method         = "DNS"

  lifecycle {
    create_before_destroy = true
  }
}

resource "aws_route53_record" "site_cert_validation" {
  for_each = local.site ? {
    for dvo in aws_acm_certificate.site[0].domain_validation_options : dvo.domain_name => {
      name   = dvo.resource_record_name
      type   = dvo.resource_record_type
      record = dvo.resource_record_value
    }
  } : {}

  zone_id         = data.aws_route53_zone.site[0].zone_id
  name            = each.value.name
  type            = each.value.type
  records         = [each.value.record]
  ttl             = 300
  allow_overwrite = true
}

resource "aws_acm_certificate_validation" "site" {
  count                   = local.site ? 1 : 0
  provider                = aws.us_east_1
  certificate_arn         = aws_acm_certificate.site[0].arn
  validation_record_fqdns = [for r in aws_route53_record.site_cert_validation : r.fqdn]
}

# ---------------------------------------------------------------------------
# CloudFront
# ---------------------------------------------------------------------------

resource "aws_cloudfront_origin_access_control" "site" {
  count                             = local.site ? 1 : 0
  name                              = "${local.name}-site"
  description                       = "Landing page bucket"
  origin_access_control_origin_type = "s3"
  signing_behavior                  = "always"
  signing_protocol                  = "sigv4"
}

# Redirects www to the apex (301, path and query kept) and serves index.html for folder paths.
resource "aws_cloudfront_function" "site_request" {
  count   = local.site ? 1 : 0
  name    = "${local.name}-site-request"
  runtime = "cloudfront-js-2.0"
  comment = "www to apex; folder paths to index.html"
  publish = true
  code    = <<-EOT
    function handler(event) {
      var request = event.request;
      var host = request.headers.host && request.headers.host.value;
      if (host === '${local.site_www}') {
        var qs = [];
        for (var key in request.querystring) {
          var p = request.querystring[key];
          if (p.multiValue) { p.multiValue.forEach(function (v) { qs.push(key + '=' + v.value); }); }
          else { qs.push(key + '=' + p.value); }
        }
        var location = 'https://${var.site_domain_name}' + request.uri + (qs.length ? '?' + qs.join('&') : '');
        return { statusCode: 301, statusDescription: 'Moved Permanently', headers: { location: { value: location } } };
      }
      if (request.uri.endsWith('/')) {
        request.uri += 'index.html';
      } else if (request.uri.split('/').pop().indexOf('.') === -1) {
        request.uri += '/index.html';
      }
      return request;
    }
  EOT
}

resource "aws_cloudfront_response_headers_policy" "site" {
  count   = local.site ? 1 : 0
  name    = "${local.name}-site-security"
  comment = "Security headers for the landing page"

  security_headers_config {
    strict_transport_security {
      access_control_max_age_sec = 63072000
      include_subdomains         = true
      preload                    = false
      override                   = true
    }
    content_type_options {
      override = true
    }
    frame_options {
      frame_option = "DENY"
      override     = true
    }
    referrer_policy {
      referrer_policy = "strict-origin-when-cross-origin"
      override        = true
    }
    content_security_policy {
      content_security_policy = var.site_content_security_policy
      override                = true
    }
  }

  custom_headers_config {
    items {
      header   = "Permissions-Policy"
      value    = "camera=(), microphone=(), geolocation=(), interest-cohort=()"
      override = true
    }
  }
}

data "aws_cloudfront_cache_policy" "caching_optimized" {
  count = local.site ? 1 : 0
  name  = "Managed-CachingOptimized"
}

resource "aws_cloudfront_distribution" "site" {
  count               = local.site ? 1 : 0
  enabled             = true
  is_ipv6_enabled     = true
  http_version        = "http2and3"
  price_class         = "PriceClass_200"
  default_root_object = "index.html"
  aliases             = local.site_aliases
  comment             = "Landing page"

  origin {
    origin_id                = "site-bucket"
    domain_name              = aws_s3_bucket.site[0].bucket_regional_domain_name
    origin_access_control_id = aws_cloudfront_origin_access_control.site[0].id
  }

  default_cache_behavior {
    target_origin_id           = "site-bucket"
    viewer_protocol_policy     = "redirect-to-https"
    allowed_methods            = ["GET", "HEAD"]
    cached_methods             = ["GET", "HEAD"]
    compress                   = true
    cache_policy_id            = data.aws_cloudfront_cache_policy.caching_optimized[0].id
    response_headers_policy_id = aws_cloudfront_response_headers_policy.site[0].id

    function_association {
      event_type   = "viewer-request"
      function_arn = aws_cloudfront_function.site_request[0].arn
    }
  }

  # Without s3:ListBucket, S3 answers a missing key with 403; both become a 404 page.
  dynamic "custom_error_response" {
    for_each = [403, 404]
    content {
      error_code            = custom_error_response.value
      response_code         = 404
      response_page_path    = var.site_not_found_path
      error_caching_min_ttl = 60
    }
  }

  restrictions {
    geo_restriction {
      restriction_type = "none"
    }
  }

  viewer_certificate {
    acm_certificate_arn      = aws_acm_certificate_validation.site[0].certificate_arn
    ssl_support_method       = "sni-only"
    minimum_protocol_version = "TLSv1.2_2021"
  }
}

# ---------------------------------------------------------------------------
# DNS: apex and www, IPv4 and IPv6, aliased to the distribution
# ---------------------------------------------------------------------------

resource "aws_route53_record" "site_alias" {
  for_each = local.site ? {
    for pair in setproduct(local.site_aliases, ["A", "AAAA"]) : "${pair[0]}-${pair[1]}" => {
      name = pair[0]
      type = pair[1]
    }
  } : {}

  zone_id = data.aws_route53_zone.site[0].zone_id
  name    = each.value.name
  type    = each.value.type

  alias {
    name                   = aws_cloudfront_distribution.site[0].domain_name
    zone_id                = aws_cloudfront_distribution.site[0].hosted_zone_id
    evaluate_target_health = false
  }
}

# ---------------------------------------------------------------------------
# Deploy role for the site repository's main branch
# ---------------------------------------------------------------------------

data "aws_iam_policy_document" "site_deploy_assume" {
  count = local.site ? 1 : 0

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
      test     = "StringEquals"
      variable = "token.actions.githubusercontent.com:sub"
      values   = ["${var.site_github_oidc_subject_prefix}:ref:refs/heads/main"]
    }
  }
}

resource "aws_iam_role" "site_deploy" {
  count                = local.site ? 1 : 0
  name                 = "${local.name}-site-deploy"
  assume_role_policy   = data.aws_iam_policy_document.site_deploy_assume[0].json
  max_session_duration = 3600
}

data "aws_iam_policy_document" "site_deploy" {
  count = local.site ? 1 : 0

  statement {
    sid       = "ListSite"
    actions   = ["s3:ListBucket"]
    resources = [aws_s3_bucket.site[0].arn]
  }

  statement {
    sid       = "WriteSite"
    actions   = ["s3:PutObject", "s3:DeleteObject"]
    resources = ["${aws_s3_bucket.site[0].arn}/*"]
  }

  statement {
    sid       = "Invalidate"
    actions   = ["cloudfront:CreateInvalidation"]
    resources = [aws_cloudfront_distribution.site[0].arn]
  }
}

resource "aws_iam_role_policy" "site_deploy" {
  count  = local.site ? 1 : 0
  name   = "deploy-site"
  role   = aws_iam_role.site_deploy[0].id
  policy = data.aws_iam_policy_document.site_deploy[0].json
}

# ---------------------------------------------------------------------------
# Outputs
# ---------------------------------------------------------------------------

output "site_github_actions_variables" {
  description = "Repository variables for the site repository's deploy workflow. Empty when the site is off."
  value = local.site ? {
    AWS_REGION             = var.region
    SITE_DEPLOY_ROLE_ARN   = aws_iam_role.site_deploy[0].arn
    SITE_BUCKET            = aws_s3_bucket.site[0].bucket
    SITE_DISTRIBUTION_ID   = aws_cloudfront_distribution.site[0].id
    SITE_CLOUDFRONT_DOMAIN = aws_cloudfront_distribution.site[0].domain_name
    SITE_URL               = "https://${var.site_domain_name}"
  } : {}
}
