variable "name" {
  description = "Name of the dev VM, also its tag value."
  type        = string

  validation {
    condition     = can(regex("^forge-[a-z0-9][a-z0-9-]*$", var.name))
    error_message = "name must match ^forge-[a-z0-9][a-z0-9-]*$."
  }
}

variable "region" {
  description = "AWS region."
  type        = string
}

variable "aws_profile" {
  description = "AWS CLI profile used by the provider."
  type        = string
}

variable "admin_public_key" {
  description = "SSH public key of the VM's admin account."
  type        = string
}

variable "ssh_cidr" {
  description = "CIDR allowed to reach SSH (a single address, /32)."
  type        = string

  validation {
    condition     = can(regex("/32$", var.ssh_cidr))
    error_message = "ssh_cidr must end in /32."
  }
}

variable "running" {
  description = "Whether the instance runs (true) or is stopped (false)."
  type        = bool
}

variable "instance_type" {
  description = "Instance type; it must support nested virtualization."
  type        = string
  default     = "m7i.2xlarge"
}

variable "disk_gb" {
  description = "Root volume size in GB."
  type        = number
  default     = 200

  validation {
    condition     = var.disk_gb >= 60
    error_message = "disk_gb must be at least 60."
  }
}

variable "budget_usd" {
  description = "Monthly cost budget in USD."
  type        = number
}

variable "alert_email" {
  description = "Address notified when the budget thresholds are crossed."
  type        = string
}

variable "idle_cpu_percent" {
  description = "Average CPU percentage under which the VM counts as idle."
  type        = number
  default     = 5
}

variable "idle_minutes" {
  description = "Minutes of idleness before the VM is stopped."
  type        = number
  default     = 120
}
