# Deploying QuickDesk on AWS EC2

This runs the whole stack (gateway, both services, PostgreSQL, MongoDB) on one EC2 instance with Docker Compose.
It is a good fit for a demo or portfolio project. For production you would use managed databases (RDS / DocumentDB or Atlas) instead.

## 1. Launch the instance
1. AWS Console → **EC2 → Launch instance**.
2. AMI: **Ubuntu Server 22.04 or 24.04 LTS**. Type: **t2.micro / t3.micro** (free-tier eligible; check your account's current free-tier terms).
3. Create or choose a **key pair** and download the `.pem` file.
4. **Security group** inbound rules:
   - SSH (22) from **My IP** only.
   - Custom TCP **8080** from Anywhere (or from My IP while testing). Do **not** open 5432, 27017, 4001 or 4002.
5. Storage: 20 GB gp3 is plenty.

## 2. Install Docker
```bash
ssh -i your-key.pem ubuntu@<EC2_PUBLIC_IP>

sudo apt-get update
sudo apt-get install -y ca-certificates curl git
curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker ubuntu
exit    # log out and back in so the docker group applies
```

## 3. Get the code and configure secrets
```bash
ssh -i your-key.pem ubuntu@<EC2_PUBLIC_IP>
git clone https://github.com/Ankitkumar021998/QuickDesk.git
cd QuickDesk
cp .env.example .env
nano .env
```
Set **strong random values** for `JWT_SECRET`, `INTERNAL_API_KEY`, `POSTGRES_PASSWORD` and `ADMIN_PASSWORD`.
You can generate one with: `openssl rand -hex 32`.

## 4. Start the stack
```bash
docker compose up -d --build
docker compose ps          # all containers should be "running" / "healthy"
docker compose logs -f gateway
```

## 5. Test it
From your laptop:
```bash
curl http://<EC2_PUBLIC_IP>:8080/health
node scripts/smoke-test.js http://<EC2_PUBLIC_IP>:8080   # needs the repo + Node 18+ locally
```
Put the URL `http://<EC2_PUBLIC_IP>:8080` in your README so reviewers can try the API.
Note: the public IP changes when you stop and start the instance, unless you attach an **Elastic IP**.

## 6. Housekeeping
- **Updating:** `git pull && docker compose up -d --build`
- **Stopping to save cost:** stop the instance in the console when you are not demoing it. Check the AWS Billing page, and set a budget alert.
- **Backups (optional):** `docker compose exec postgres pg_dump -U quickdesk quickdesk_auth > backup.sql`
- **HTTPS (optional):** put Nginx or an AWS load balancer in front, with a domain and a free Let's Encrypt / ACM certificate.
