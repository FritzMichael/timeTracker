# Time Tracker - VPS Deployment Guide

## Prerequisites on your VPS

1. **Install Docker & Docker Compose:**
```bash
# Ubuntu/Debian
curl -fsSL https://get.docker.com | sh
sudo usermod -aG docker $USER
# Log out and back in for group changes to take effect
```

2. **Install Git:**
```bash
sudo apt update && sudo apt install -y git
```

## Initial Setup (one-time)

1. **Clone the repository:**
```bash
cd /opt  # or wherever you want to install
git clone https://github.com/YOUR_USERNAME/timeTracker.git
cd timeTracker
```

2. **Create the .env file:**
```bash
cp .env.example .env
nano .env  # Edit with your actual values
```

Required `.env` values:
```
SESSION_SECRET=generate-a-long-random-string-here
GITHUB_CLIENT_ID=your_github_oauth_app_id
GITHUB_CLIENT_SECRET=your_github_oauth_app_secret
GITHUB_CALLBACK_URL=https://yourdomain.com/auth/github/callback
PORT=3000
NODE_ENV=production
```

3. **Make deploy script executable:**
```bash
chmod +x deploy.sh
```

4. **Initial deployment:**
```bash
./deploy.sh
```

## Updating (single command!)

SSH into your VPS and run:
```bash
cd /opt/timeTracker && ./deploy.sh
```

Or as a one-liner from anywhere:
```bash
ssh user@your-vps "cd /opt/timeTracker && ./deploy.sh"
```

## Setting up HTTPS with Caddy (recommended)

1. **Install Caddy:**
```bash
sudo apt install -y debian-keyring debian-archive-keyring apt-transport-https
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | sudo tee /etc/apt/sources.list.d/caddy-stable.list
sudo apt update && sudo apt install caddy
```

2. **Configure Caddy** (`/etc/caddy/Caddyfile`):
```
timetracker.yourdomain.com {
    reverse_proxy localhost:3000
}
```

3. **Restart Caddy:**
```bash
sudo systemctl restart caddy
```

Caddy automatically provisions and renews SSL certificates from Let's Encrypt!

## Alternative: Using Nginx + Certbot

```bash
sudo apt install -y nginx certbot python3-certbot-nginx

# Create nginx config
sudo nano /etc/nginx/sites-available/timetracker
```

```nginx
server {
    listen 80;
    server_name timetracker.yourdomain.com;

    location / {
        proxy_pass http://localhost:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_cache_bypass $http_upgrade;
    }
}
```

```bash
sudo ln -s /etc/nginx/sites-available/timetracker /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl restart nginx
sudo certbot --nginx -d timetracker.yourdomain.com
```

## Firewall Setup

```bash
sudo ufw allow 22    # SSH
sudo ufw allow 80    # HTTP
sudo ufw allow 443   # HTTPS
sudo ufw enable
```

## Monitoring

Check container status:
```bash
docker-compose -f docker-compose.prod.yml ps
```

View logs:
```bash
docker-compose -f docker-compose.prod.yml logs -f
```

## Backup

The SQLite database is in `./data/`. To backup:
```bash
cp data/timetracker.db ~/backups/timetracker-$(date +%Y%m%d).db
```

## GitHub OAuth for Production

Update your GitHub OAuth App settings:
- **Homepage URL:** `https://timetracker.yourdomain.com`
- **Authorization callback URL:** `https://timetracker.yourdomain.com/auth/github/callback`
