terraform {
  required_version = ">= 1.10"

  required_providers {
    aws = {
      source = "hashicorp/aws"
      # Nested virtualization (cpu_options) is in place since 6.34.0.
      version = ">= 6.34.0, < 7.0.0"
    }
  }

  # The path comes from -backend-config=path=... (forge keeps the state under
  # the laptop state directory).
  backend "local" {}
}

provider "aws" {
  region  = var.region
  profile = var.aws_profile

  default_tags {
    tags = {
      "agent-forge" = var.name
    }
  }
}
