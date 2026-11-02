# No NAT gateway: tasks run in public subnets with public IPs and are protected by security groups.
# The database sits in subnets with no route to the internet.

resource "aws_vpc" "main" {
  cidr_block           = var.vpc_cidr
  enable_dns_support   = true
  enable_dns_hostnames = true

  tags = { Name = local.name }
}

resource "aws_internet_gateway" "main" {
  vpc_id = aws_vpc.main.id
  tags   = { Name = local.name }
}

resource "aws_subnet" "public" {
  count = 2

  vpc_id                  = aws_vpc.main.id
  availability_zone       = local.azs[count.index]
  cidr_block              = cidrsubnet(var.vpc_cidr, 8, count.index)
  map_public_ip_on_launch = false

  tags = { Name = "${local.name}-public-${count.index}" }
}

resource "aws_subnet" "database" {
  count = 2

  vpc_id                  = aws_vpc.main.id
  availability_zone       = local.azs[count.index]
  cidr_block              = cidrsubnet(var.vpc_cidr, 8, count.index + 10)
  map_public_ip_on_launch = false

  tags = { Name = "${local.name}-database-${count.index}" }
}

resource "aws_route_table" "public" {
  vpc_id = aws_vpc.main.id

  route {
    cidr_block = "0.0.0.0/0"
    gateway_id = aws_internet_gateway.main.id
  }

  tags = { Name = "${local.name}-public" }
}

resource "aws_route_table_association" "public" {
  count = 2

  subnet_id      = aws_subnet.public[count.index].id
  route_table_id = aws_route_table.public.id
}

# Database subnets use their own table with only the local route.
resource "aws_route_table" "database" {
  vpc_id = aws_vpc.main.id
  tags   = { Name = "${local.name}-database" }
}

resource "aws_route_table_association" "database" {
  count = 2

  subnet_id      = aws_subnet.database[count.index].id
  route_table_id = aws_route_table.database.id
}

# S3 over the AWS network instead of the internet. No hourly charge.
resource "aws_vpc_endpoint" "s3" {
  vpc_id            = aws_vpc.main.id
  service_name      = "com.amazonaws.${var.region}.s3"
  vpc_endpoint_type = "Gateway"
  route_table_ids   = [aws_route_table.public.id]

  tags = { Name = "${local.name}-s3" }
}

# ---------------------------------------------------------------------------
# Security groups. Rules are separate resources so the groups can reference each other.
# ---------------------------------------------------------------------------

resource "aws_security_group" "vpc_link" {
  name        = "${local.name}-vpc-link"
  description = "API Gateway VPC link. Can reach the API tasks only."
  vpc_id      = aws_vpc.main.id
}

resource "aws_security_group" "api" {
  name        = "${local.name}-api"
  description = "API tasks. Accept traffic from the VPC link only."
  vpc_id      = aws_vpc.main.id
}

resource "aws_security_group" "worker" {
  name        = "${local.name}-worker"
  description = "Extraction worker. No inbound traffic."
  vpc_id      = aws_vpc.main.id
}

resource "aws_security_group" "database" {
  name        = "${local.name}-database"
  description = "PostgreSQL. Accepts the API tasks only."
  vpc_id      = aws_vpc.main.id
}

resource "aws_vpc_security_group_egress_rule" "vpc_link_to_api" {
  security_group_id            = aws_security_group.vpc_link.id
  referenced_security_group_id = aws_security_group.api.id
  ip_protocol                  = "tcp"
  from_port                    = local.api_container_port
  to_port                      = local.api_container_port
  description                  = "VPC link to API tasks"
}

resource "aws_vpc_security_group_ingress_rule" "api_from_vpc_link" {
  security_group_id            = aws_security_group.api.id
  referenced_security_group_id = aws_security_group.vpc_link.id
  ip_protocol                  = "tcp"
  from_port                    = local.api_container_port
  to_port                      = local.api_container_port
  description                  = "From the API Gateway VPC link only"
}

resource "aws_vpc_security_group_egress_rule" "api_https" {
  security_group_id = aws_security_group.api.id
  cidr_ipv4         = "0.0.0.0/0"
  ip_protocol       = "tcp"
  from_port         = 443
  to_port           = 443
  description       = "AWS APIs (ECR, S3, SQS, SES, Parameter Store, CloudWatch)"
}

resource "aws_vpc_security_group_egress_rule" "api_to_database" {
  security_group_id            = aws_security_group.api.id
  referenced_security_group_id = aws_security_group.database.id
  ip_protocol                  = "tcp"
  from_port                    = 5432
  to_port                      = 5432
  description                  = "PostgreSQL"
}

resource "aws_vpc_security_group_ingress_rule" "database_from_api" {
  security_group_id            = aws_security_group.database.id
  referenced_security_group_id = aws_security_group.api.id
  ip_protocol                  = "tcp"
  from_port                    = 5432
  to_port                      = 5432
  description                  = "From API and migration tasks"
}

resource "aws_vpc_security_group_egress_rule" "worker_https" {
  security_group_id = aws_security_group.worker.id
  cidr_ipv4         = "0.0.0.0/0"
  ip_protocol       = "tcp"
  from_port         = 443
  to_port           = 443
  description       = "AWS APIs and the Gemini API"
}
