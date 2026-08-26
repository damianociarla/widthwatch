#!/usr/bin/env bash
set -euo pipefail
: "${AWS_ACCOUNT_ID:?Set AWS_ACCOUNT_ID}"
: "${AWS_ECR_ACCESS_ROLE_ARN:?Set AWS_ECR_ACCESS_ROLE_ARN}"
: "${AWS_CLOUDFORMATION_ROLE_ARN:?Set AWS_CLOUDFORMATION_ROLE_ARN}"
: "${AWS_SCANNER_SWITCH_EXECUTION_ROLE_ARN:?Set AWS_SCANNER_SWITCH_EXECUTION_ROLE_ARN}"
: "${WIDTHWATCH_ORIGIN_VERIFY_TOKEN:?Set WIDTHWATCH_ORIGIN_VERIFY_TOKEN}"
: "${WIDTHWATCH_BUDGET_ALERT_EMAIL:?Set WIDTHWATCH_BUDGET_ALERT_EMAIL}"
aws_region="${AWS_REGION:-eu-west-1}"
tag="${WIDTHWATCH_IMAGE_TAG:-latest}"
repository="widthwatch-api"
registry="${AWS_ACCOUNT_ID}.dkr.ecr.${aws_region}.amazonaws.com"
if ! aws cloudformation describe-stacks --region us-east-1 --stack-name widthwatch-scanner-switch >/dev/null 2>&1; then
  echo "Bootstrapping the independent scanner switch in its fail-closed disabled state."
  aws cloudformation deploy --region us-east-1 --stack-name widthwatch-scanner-switch --template-file infra/aws/scanner-switch.yml --role-arn "$AWS_SCANNER_SWITCH_EXECUTION_ROLE_ARN"
fi
scanner_switch_arn="$(aws cloudformation describe-stacks --region us-east-1 --stack-name widthwatch-scanner-switch --query "Stacks[0].Outputs[?OutputKey=='RuleGroupArn'].OutputValue|[0]" --output text)"
if [[ -z "$scanner_switch_arn" || "$scanner_switch_arn" == "None" ]]; then
  echo "The fail-closed widthwatch-scanner-switch stack did not expose its rule group ARN." >&2
  exit 1
fi
aws ecr describe-repositories --region "$aws_region" --repository-names "$repository" >/dev/null 2>&1 || aws ecr create-repository --region "$aws_region" --repository-name "$repository" --image-tag-mutability IMMUTABLE --image-scanning-configuration scanOnPush=true >/dev/null
if aws ecr describe-images --region "$aws_region" --repository-name "$repository" --image-ids "imageTag=$tag" >/dev/null 2>&1; then
  echo "Image $registry/$repository:$tag already exists; reusing the immutable release image."
else
  aws ecr get-login-password --region "$aws_region" | docker login --username AWS --password-stdin "$registry"
  docker build --platform linux/amd64 -t "$registry/$repository:$tag" .
  docker push "$registry/$repository:$tag"
fi
aws cloudformation deploy --region "$aws_region" --stack-name widthwatch-api --template-file infra/aws/apprunner.yml --role-arn "$AWS_CLOUDFORMATION_ROLE_ARN" --parameter-overrides "ImageIdentifier=$registry/$repository:$tag" "EcrAccessRoleArn=$AWS_ECR_ACCESS_ROLE_ARN" "InstanceRoleArn=${AWS_INSTANCE_ROLE_ARN:-}" "OriginVerifyToken=$WIDTHWATCH_ORIGIN_VERIFY_TOKEN" "BudgetAlertEmail=${WIDTHWATCH_BUDGET_ALERT_EMAIL:-}"
origin="$(aws cloudformation describe-stacks --region "$aws_region" --stack-name widthwatch-api --query "Stacks[0].Outputs[?OutputKey=='ServiceUrl'].OutputValue|[0]" --output text)"
aws cloudformation describe-stacks --region "$aws_region" --stack-name widthwatch-api --query "Stacks[0].Outputs" --output table
aws cloudformation deploy --region us-east-1 --stack-name widthwatch-edge --template-file infra/aws/cloudfront-waf.yml --role-arn "$AWS_CLOUDFORMATION_ROLE_ARN" --parameter-overrides "OriginDomain=$origin" "OriginVerifyToken=$WIDTHWATCH_ORIGIN_VERIFY_TOKEN" "AlertEmail=$WIDTHWATCH_BUDGET_ALERT_EMAIL" "ScannerSwitchRuleGroupArn=$scanner_switch_arn"
aws cloudformation describe-stacks --region us-east-1 --stack-name widthwatch-edge --query "Stacks[0].Outputs" --output table
