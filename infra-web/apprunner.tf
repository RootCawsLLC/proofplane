resource "aws_apprunner_service" "app" {
  count        = var.deploy_service ? 1 : 0
  service_name = var.project

  source_configuration {
    authentication_configuration {
      access_role_arn = aws_iam_role.apprunner_access.arn
    }
    auto_deployments_enabled = false

    image_repository {
      image_identifier      = "${aws_ecr_repository.app.repository_url}:${var.image_tag}"
      image_repository_type = "ECR"

      image_configuration {
        port = "3300"
        # These are already baked into the image (see web/Dockerfile ENV); set here too so the
        # deployment is self-describing and an operator can see how the tool is located.
        runtime_environment_variables = {
          NODE_ENV          = "production"
          PROOFPLANE_ROOT   = "/repo"
          PROOFPLANE_PYTHON = "/opt/probe-venv/bin/python"
        }
      }
    }
  }

  instance_configuration {
    cpu    = var.app_cpu
    memory = var.app_memory
    # No instance role: the app calls no AWS APIs. It contacts nothing external at runtime —
    # every attack runs against a target server it boots itself on 127.0.0.1.
  }

  network_configuration {
    egress_configuration {
      egress_type = "DEFAULT"
    }
  }

  health_check_configuration {
    protocol            = "HTTP"
    path                = "/"
    interval            = 10
    timeout             = 5
    healthy_threshold   = 1
    unhealthy_threshold = 5
  }
}
