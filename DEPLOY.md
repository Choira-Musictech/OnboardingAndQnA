# Deployment

How this service runs on the IPRS server, and what it depends on.

## Live

| | |
| --- | --- |
| URL | https://api.iprs.choira.io |
| Host | 20.55.99.87 (Azure `Standard_D8s_v4`, Ubuntu 24.04) |
| Path | `~/IPRS_PROJECTS/onboarding_api` |
| Port | 4001 (behind nginx; not reachable directly) |
| Process | pm2, name `onboarding-api` |

Ports 3000, 3001 and 4000 are taken by other services on the same host, which is
why this one runs on 4001.

## Services it depends on

| Dependency | Where | Notes |
| --- | --- | --- |
| SQL Server 2025 | `localhost:1433`, db `Dreamsoft_UAT` | Developer edition, same host |
| OCR API | https://ocr.choira.io | `OCR_API_BASE_URL` |
| Chat uploads | this server's disk | `UPLOAD_DIR` (outside the deploy folder), served at `DOCUMENT_LINK_BASE_URL/uploads/...` |

The onboarding flow runs inside the API (built-in flow engine) — there is no Typebot server to
deploy or configure any more. `DOCUMENT_LINK_BASE_URL` must be the API's public https address: the
OCR service downloads uploaded documents from it.

## First-time setup

1. Install SQL Server. Only **2025** has an Ubuntu 24.04 package; 2022 does not.

       curl -sSL https://packages.microsoft.com/keys/microsoft.asc \
         | sudo gpg --dearmor -o /usr/share/keyrings/microsoft-prod.gpg
       curl -sSL https://packages.microsoft.com/config/ubuntu/24.04/mssql-server-2025.list \
         | sudo tee /etc/apt/sources.list.d/mssql-server-2025.list
       curl -sSL https://packages.microsoft.com/config/ubuntu/24.04/prod.list \
         | sudo tee /etc/apt/sources.list.d/msprod.list
       sudo apt-get update && sudo apt-get install -y mssql-server mssql-tools18
       sudo MSSQL_PID=Developer /opt/mssql/bin/mssql-conf -n setup accept-eula

   Write the list files verbatim: they already carry the correct `signed-by`.

2. Create the database and load `mra.sql`. The export is UTF-16LE, so convert
   it first or sqlcmd will not read it:

       iconv -f UTF-16LE -t UTF-8 mra.sql | tr -d "\r" > mra-utf8.sql
       sqlcmd -S localhost -U sa -P "$SA" -C -Q "CREATE DATABASE [Dreamsoft_UAT]"
       sqlcmd -S localhost -U sa -P "$SA" -C -d Dreamsoft_UAT -i mra-utf8.sql

3. Apply `deploy/sql/01-create-app-login.sql` and `deploy/sql/02-schema-gaps.sql`.

4. Copy `deploy/env/onboarding_api.env.example` to `.env`, fill in the two
   secrets, `chmod 600`.

5. Install and start:

       npm ci --omit=dev
       npx prisma generate
       pm2 start src/server.js --name onboarding-api --time
       pm2 save

6. Put nginx in front using `deploy/nginx/api.iprs.choira.io.conf`, then issue a
   certificate. Port 80 must be open in the Azure NSG for the ACME challenge,
   even though all real traffic redirects to HTTPS:

       sudo certbot --nginx -d api.iprs.choira.io

## Redeploy

    cd ~/IPRS_PROJECTS/onboarding_api
    git pull
    npm ci --omit=dev
    npx prisma generate
    pm2 restart onboarding-api --update-env

## Verify

    curl https://api.iprs.choira.io/health
    # {"success":true,"data":{"status":"ok","db":"up", ...}}

## Known gaps

- **`mra.sql` is older than `prisma/schema.prisma`.** `PANNo` on `App_Accounts`
  was missing and is added by `deploy/sql/02-schema-gaps.sql`. Every other
  Prisma column was verified present. Five foreign keys and five routines from
  the export cannot be created because their targets are absent; the API does
  not use them. A full export would close this properly.
- **OTP is mocked.** `OTP_PROVIDER=mock` accepts `123456` for any number, and
  the endpoint is publicly reachable. Set `OTP_PROVIDER=sms` with MSG91
  credentials before real users.
- **`CORS_ORIGIN=*`** on a public API that handles identity documents.
- **pm2 does not survive a reboot.** No systemd unit is installed; run
  `pm2 startup systemd` and the sudo command it prints.
