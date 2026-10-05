#!/usr/bin/env bash
# Deletes everything deploy.sh created (resources tagged Project=$STACK_NAME).
set -euo pipefail

: "${AWS_REGION:?AWS_REGION is required}"
export AWS_DEFAULT_REGION="$AWS_REGION"
STACK_NAME="${STACK_NAME:-cloud-job-runner}"

INSTANCE_IDS=$(aws ec2 describe-instances \
  --filters Name=tag:Project,Values="$STACK_NAME" Name=instance-state-name,Values=pending,running,stopping,stopped \
  --query 'Reservations[].Instances[].InstanceId' --output text)
for alloc in $(aws ec2 describe-addresses --filters Name=tag:Project,Values="$STACK_NAME" \
  --query 'Addresses[].AllocationId' --output text); do
  assoc=$(aws ec2 describe-addresses --allocation-ids "$alloc" --query 'Addresses[0].AssociationId' --output text)
  [ "$assoc" != "None" ] && aws ec2 disassociate-address --association-id "$assoc"
  aws ec2 release-address --allocation-id "$alloc"
done
if [ -n "$INSTANCE_IDS" ]; then
  aws ec2 terminate-instances --instance-ids $INSTANCE_IDS >/dev/null
  aws ec2 wait instance-terminated --instance-ids $INSTANCE_IDS
fi
for sg in $(aws ec2 describe-security-groups --filters Name=group-name,Values="$STACK_NAME-sg" \
  --query 'SecurityGroups[].GroupId' --output text); do
  aws ec2 delete-security-group --group-id "$sg"
done
echo "Torn down $STACK_NAME in $AWS_REGION"
