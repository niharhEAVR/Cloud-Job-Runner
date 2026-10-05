#!/usr/bin/env bash
# Provisions a single EC2 instance running the full stack (api, worker, redis) via Docker Compose.
# Uses whatever AWS credentials the AWS CLI finds (env vars, profile, SSO); none are stored here.
#
# Usage: AWS_REGION=us-east-1 ./deploy/ec2/deploy.sh
# Optional env: STACK_NAME, INSTANCE_TYPE, REPO_URL, REPO_REF
set -euo pipefail

: "${AWS_REGION:?AWS_REGION is required}"
export AWS_DEFAULT_REGION="$AWS_REGION"
STACK_NAME="${STACK_NAME:-cloud-job-runner}"
INSTANCE_TYPE="${INSTANCE_TYPE:-t4g.small}"
REPO_URL="${REPO_URL:-https://github.com/niharhEAVR/Cloud-Job-Runner.git}"
REPO_REF="${REPO_REF:-main}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

case "$INSTANCE_TYPE" in
  *g.*|*gd.*|*gn.*) ARCH=arm64 ;;
  *) ARCH=amd64 ;;
esac
AMI_ID=$(aws ssm get-parameters \
  --names "/aws/service/canonical/ubuntu/server/24.04/stable/current/$ARCH/hvm/ebs-gp3/ami-id" \
  --query 'Parameters[0].Value' --output text)

VPC_ID=$(aws ec2 describe-vpcs --filters Name=isDefault,Values=true --query 'Vpcs[0].VpcId' --output text)
if [ "$VPC_ID" = "None" ]; then
  echo "No default VPC in $AWS_REGION" >&2
  exit 1
fi

SG_ID=$(aws ec2 describe-security-groups \
  --filters Name=group-name,Values="$STACK_NAME-sg" Name=vpc-id,Values="$VPC_ID" \
  --query 'SecurityGroups[0].GroupId' --output text)
if [ "$SG_ID" = "None" ]; then
  SG_ID=$(aws ec2 create-security-group --group-name "$STACK_NAME-sg" \
    --description "$STACK_NAME: public HTTP to the API only" --vpc-id "$VPC_ID" \
    --query GroupId --output text)
  aws ec2 authorize-security-group-ingress --group-id "$SG_ID" \
    --ip-permissions 'IpProtocol=tcp,FromPort=80,ToPort=80,IpRanges=[{CidrIp=0.0.0.0/0,Description=API}]' >/dev/null
  aws ec2 create-tags --resources "$SG_ID" --tags Key=Project,Value="$STACK_NAME"
fi

USER_DATA_FILE=$(mktemp)
sed -e "s|__REPO_URL__|$REPO_URL|" -e "s|__REPO_REF__|$REPO_REF|" "$SCRIPT_DIR/user-data.sh" > "$USER_DATA_FILE"

INSTANCE_ID=$(aws ec2 run-instances \
  --image-id "$AMI_ID" --instance-type "$INSTANCE_TYPE" \
  --security-group-ids "$SG_ID" \
  --metadata-options HttpTokens=required,HttpEndpoint=enabled \
  --block-device-mappings 'DeviceName=/dev/sda1,Ebs={VolumeSize=20,VolumeType=gp3,Encrypted=true}' \
  --user-data "file://$USER_DATA_FILE" \
  --tag-specifications "ResourceType=instance,Tags=[{Key=Name,Value=$STACK_NAME},{Key=Project,Value=$STACK_NAME}]" \
                       "ResourceType=volume,Tags=[{Key=Project,Value=$STACK_NAME}]" \
  --query 'Instances[0].InstanceId' --output text)
rm -f "$USER_DATA_FILE"
echo "Launched $INSTANCE_ID, waiting for it to run..."
aws ec2 wait instance-running --instance-ids "$INSTANCE_ID"

ALLOC_ID=$(aws ec2 allocate-address --domain vpc \
  --tag-specifications "ResourceType=elastic-ip,Tags=[{Key=Project,Value=$STACK_NAME}]" \
  --query AllocationId --output text)
aws ec2 associate-address --instance-id "$INSTANCE_ID" --allocation-id "$ALLOC_ID" >/dev/null
PUBLIC_IP=$(aws ec2 describe-addresses --allocation-ids "$ALLOC_ID" --query 'Addresses[0].PublicIp' --output text)

echo "Instance:  $INSTANCE_ID"
echo "Public IP: $PUBLIC_IP (Elastic IP $ALLOC_ID)"
echo "API URL:   http://$PUBLIC_IP/  (ready a few minutes after boot, once Docker builds the image)"
