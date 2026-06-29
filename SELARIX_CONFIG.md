# SELARIX Operations — Agent Config
Last updated: 2026-04-03

## EC2 Infrastructure
- Public IP: 3.20.79.143
- User: ubuntu
- Instance: i-0a3669c59fb773d31 (us-east-2)
- Access: ssh -i C:\Users\mikeb\.ssh\clawdbot-clean.pem ubuntu@3.20.79.143
- If no SSH key: use EC2 Instance Connect at AWS console

## Agent Commands (run on EC2 after SSH)
### Security Engineer
source ~/.selarix.env && bash ~/qsl-swarm/CABINET/security_engineer/scripts/health-check.sh

### TreasuryBot
source ~/.selarix.env && /home/ubuntu/miniconda3/bin/python3 ~/qsl-swarm/CABINET/treasurybot/src/treasurybot.py report 2>/dev/null

### SalesBot
source ~/.selarix.env && /home/ubuntu/miniconda3/bin/python3 ~/qsl-swarm/CABINET/salesbot/src/salesbot.py summary 2>/dev/null

### OpsBot
source ~/.selarix.env && /home/ubuntu/miniconda3/bin/python3 ~/qsl-swarm/CABINET/opsbot/src/opsbot.py status 2>/dev/null

## Wallet
CrawDaddy: 0x25B50fEd69175e474F9702C0613413F8323809a8
Current balance: $37.37 USDC
Bastion gate: $500/month sustained 30 days

## Revenue Gate
When USDC wallet reaches $500/month for 30 consecutive days:
→ Bastion wakes up
→ $ATTEST token launches
