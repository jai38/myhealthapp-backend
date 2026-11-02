# Alarms, worker scaling from queue depth, and the cost budget.

# Not encrypted with a KMS key: CloudWatch alarms cannot publish to a topic that uses the AWS-managed key.
# Messages hold alarm names only.
resource "aws_sns_topic" "alerts" {
  name = "${local.name}-alerts"
}

resource "aws_sns_topic_subscription" "alert_email" {
  topic_arn = aws_sns_topic.alerts.arn
  protocol  = "email"
  endpoint  = var.alert_email
}

# ---------------------------------------------------------------------------
# Worker scaling: 0 when the queue is empty, up when a job is waiting.
# Latency from an empty queue to a running worker is the alarm period plus task start, about 2-3 minutes.
# ---------------------------------------------------------------------------

resource "aws_appautoscaling_policy" "worker_out" {
  name               = "${local.name}-worker-out"
  policy_type        = "StepScaling"
  service_namespace  = aws_appautoscaling_target.worker.service_namespace
  scalable_dimension = aws_appautoscaling_target.worker.scalable_dimension
  resource_id        = aws_appautoscaling_target.worker.resource_id

  step_scaling_policy_configuration {
    adjustment_type         = "ExactCapacity"
    cooldown                = 60
    metric_aggregation_type = "Maximum"

    step_adjustment {
      metric_interval_lower_bound = 0
      scaling_adjustment          = var.worker_max_count
    }
  }
}

resource "aws_appautoscaling_policy" "worker_in" {
  name               = "${local.name}-worker-in"
  policy_type        = "StepScaling"
  service_namespace  = aws_appautoscaling_target.worker.service_namespace
  scalable_dimension = aws_appautoscaling_target.worker.scalable_dimension
  resource_id        = aws_appautoscaling_target.worker.resource_id

  step_scaling_policy_configuration {
    adjustment_type         = "ExactCapacity"
    cooldown                = 300
    metric_aggregation_type = "Maximum"

    step_adjustment {
      metric_interval_upper_bound = 0
      scaling_adjustment          = 0
    }
  }
}

resource "aws_cloudwatch_metric_alarm" "jobs_waiting" {
  alarm_name          = "${local.name}-extraction-jobs-waiting"
  alarm_description   = "A job is waiting: start the worker."
  namespace           = "AWS/SQS"
  metric_name         = "ApproximateNumberOfMessagesVisible"
  dimensions          = { QueueName = aws_sqs_queue.jobs.name }
  statistic           = "Maximum"
  period              = 60
  evaluation_periods  = 1
  threshold           = 1
  comparison_operator = "GreaterThanOrEqualToThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_appautoscaling_policy.worker_out.arn]
}

# Counts waiting plus in-flight messages so the worker is never stopped while it holds a job.
resource "aws_cloudwatch_metric_alarm" "jobs_idle" {
  alarm_name          = "${local.name}-extraction-jobs-idle"
  alarm_description   = "No jobs waiting or running for a while: stop the worker."
  evaluation_periods  = var.worker_idle_minutes_before_scale_in
  threshold           = 1
  comparison_operator = "LessThanThreshold"
  treat_missing_data  = "breaching"
  alarm_actions       = [aws_appautoscaling_policy.worker_in.arn]

  metric_query {
    id          = "total"
    expression  = "visible + inflight"
    label       = "Jobs waiting or running"
    return_data = true
  }

  metric_query {
    id = "visible"

    metric {
      namespace   = "AWS/SQS"
      metric_name = "ApproximateNumberOfMessagesVisible"
      dimensions  = { QueueName = aws_sqs_queue.jobs.name }
      period      = 60
      stat        = "Maximum"
    }
  }

  metric_query {
    id = "inflight"

    metric {
      namespace   = "AWS/SQS"
      metric_name = "ApproximateNumberOfMessagesNotVisible"
      dimensions  = { QueueName = aws_sqs_queue.jobs.name }
      period      = 60
      stat        = "Maximum"
    }
  }
}

# ---------------------------------------------------------------------------
# Alarms that tell the owner something needs a person.
# ---------------------------------------------------------------------------

resource "aws_cloudwatch_metric_alarm" "dead_letters" {
  for_each = {
    jobs    = aws_sqs_queue.jobs_dlq.name
    results = aws_sqs_queue.results_dlq.name
  }

  alarm_name          = "${local.name}-${each.key}-dead-letters"
  alarm_description   = "A ${each.key} message could not be processed and was set aside."
  namespace           = "AWS/SQS"
  metric_name         = "ApproximateNumberOfMessagesVisible"
  dimensions          = { QueueName = each.value }
  statistic           = "Maximum"
  period              = 300
  evaluation_periods  = 1
  threshold           = 1
  comparison_operator = "GreaterThanOrEqualToThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_sns_topic.alerts.arn]
}

resource "aws_cloudwatch_metric_alarm" "database_storage" {
  alarm_name          = "${local.name}-database-low-storage"
  alarm_description   = "Database has under 3 GB free."
  namespace           = "AWS/RDS"
  metric_name         = "FreeStorageSpace"
  dimensions          = { DBInstanceIdentifier = aws_db_instance.main.identifier }
  statistic           = "Minimum"
  period              = 300
  evaluation_periods  = 2
  threshold           = 3221225472
  comparison_operator = "LessThanThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_sns_topic.alerts.arn]
}

# ---------------------------------------------------------------------------
# Budget
# ---------------------------------------------------------------------------

resource "aws_budgets_budget" "monthly" {
  name         = "${local.name}-monthly"
  budget_type  = "COST"
  limit_amount = tostring(var.budget_monthly_usd)
  limit_unit   = "USD"
  time_unit    = "MONTHLY"

  notification {
    comparison_operator        = "GREATER_THAN"
    threshold                  = 80
    threshold_type             = "PERCENTAGE"
    notification_type          = "ACTUAL"
    subscriber_email_addresses = [var.alert_email]
  }

  notification {
    comparison_operator        = "GREATER_THAN"
    threshold                  = 100
    threshold_type             = "PERCENTAGE"
    notification_type          = "FORECASTED"
    subscriber_email_addresses = [var.alert_email]
  }
}
