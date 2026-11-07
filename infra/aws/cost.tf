# Monthly budget: mail at 80 % of the spend and at 100 % of the forecast.
resource "aws_budgets_budget" "dev" {
  name         = var.name
  budget_type  = "COST"
  limit_amount = tostring(var.budget_usd)
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

# Stops an idle VM. The stop action is EC2's built-in one, so the instance
# needs no role.
resource "aws_cloudwatch_metric_alarm" "idle" {
  alarm_name          = "${var.name}-idle"
  namespace           = "AWS/EC2"
  metric_name         = "CPUUtilization"
  dimensions          = { InstanceId = aws_instance.dev.id }
  statistic           = "Average"
  period              = 300
  evaluation_periods  = floor(var.idle_minutes / 5)
  comparison_operator = "LessThanThreshold"
  threshold           = var.idle_cpu_percent
  treat_missing_data  = "notBreaching"
  alarm_actions       = ["arn:aws:automate:${var.region}:ec2:stop"]
}
