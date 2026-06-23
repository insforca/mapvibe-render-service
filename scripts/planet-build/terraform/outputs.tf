output "instance_id" {
  description = "Spot instance ID. Watch state via: aws ec2 describe-instances --instance-ids <id>."
  value       = aws_instance.planet_build.id
}

output "public_ip" {
  description = "Public IP for SSH access. May be null briefly during launch — re-run terraform refresh to fetch."
  value       = aws_instance.planet_build.public_ip
}

output "ssh_command" {
  description = "Ready-to-paste SSH command (once the instance is in `running` state)."
  value       = "ssh -i ~/.ssh/${var.key_name}.pem ubuntu@${aws_instance.planet_build.public_ip}"
}

output "log_tail_command" {
  description = "Run after SSH to follow the planet build log."
  value       = "tail -f /var/log/planet-build.log"
}