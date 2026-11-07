output "address" {
  description = "Public address (Elastic IP) of the dev VM."
  value       = aws_eip.dev.public_ip
}

output "instance_id" {
  description = "Instance ID of the dev VM."
  value       = aws_instance.dev.id
}
