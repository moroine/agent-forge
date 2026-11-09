output "address" {
  description = "Public address (Elastic IP) of the dev VM."
  value       = aws_eip.dev.public_ip
}

output "instance_id" {
  description = "Instance ID of the dev VM."
  value       = aws_instance.dev.id
}

output "relay_address" {
  description = "Public address (Elastic IP) of the relay."
  value       = aws_eip.relay.public_ip
}

output "relay_private_ip" {
  description = "Private address of the relay, which the dev VM reaches it at."
  value       = aws_instance.relay.private_ip
}

output "subnet_cidr" {
  description = "CIDR of the subnet both VMs live in."
  value       = aws_subnet.dev.cidr_block
}
