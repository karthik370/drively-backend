# ============================================================
# DriveMate Complete Database Backup Script
# Backs up ALL 37 tables: users, trips, payments, subscriptions,
# ratings, support, wallet, badges, KYC, emergency, etc.
# ============================================================

param(
    [string]$Mode = "full",   # full | report | restore
    [string]$BackupFile = ""  # for restore mode
)

# ── Connection (Railway PostGIS public URL) ───────────────────
$env:PGPASSWORD = "bCfD3EaaDEedf44B6B6F3FfBec3F3654"
$DB_HOST   = "viaduct.proxy.rlwy.net"
$DB_PORT   = "44683"
$DB_USER   = "postgres"
$DB_NAME   = "railway"

# ── Backup directory ──────────────────────────────────────────
$TIMESTAMP  = Get-Date -Format "yyyy-MM-dd_HH-mm-ss"
$BACKUP_DIR = "$PSScriptRoot\..\backups"

if (-not (Test-Path $BACKUP_DIR)) {
    New-Item -ItemType Directory -Path $BACKUP_DIR | Out-Null
}

# ── All tables (38 data tables, excludes PostGIS system table) ─
$TABLES = @(
    "users",
    "customer_profiles",
    "driver_profiles",
    "bookings",
    "driver_refunds",
    "locations",
    "payments",
    "wallet_transactions",
    "membership_plans",
    "driver_subscriptions",
    "membership_purchases",
    "tips",
    "invoices",
    "promotions",
    "promotion_redemptions",
    "ratings",
    "support_tickets",
    "notifications",
    "expo_push_tokens",
    "insurances",
    "referral_codes",
    "vehicles",
    "emergencies",
    "corporates",
    "sessions",
    "otp_verifications",
    "admin_users",
    "app_configs",
    "referrals",
    "driver_incentives",
    "driver_incentive_progress",
    "driver_payouts",
    "rewards_coins",
    "trip_photos",
    "badge_definitions",
    "badge_quizzes",
    "driver_badges",
    "kyc_verifications"
)


# ── Check pg_dump available ───────────────────────────────────
function Check-PgDump {
    try {
        $null = & pg_dump --version 2>&1
        return $true
    } catch {
        Write-Host "ERROR: pg_dump not found! Install PostgreSQL client tools." -ForegroundColor Red
        Write-Host "   Download: https://www.postgresql.org/download/windows/" -ForegroundColor Yellow
        exit 1
    }
}

# ── FULL BACKUP ───────────────────────────────────────────────
function Full-Backup {
    Write-Host ""
    Write-Host "DriveMate Complete Database Backup" -ForegroundColor Cyan
    Write-Host "====================================" -ForegroundColor Cyan
    Write-Host "Timestamp : $TIMESTAMP"
    Write-Host "Database  : $DB_NAME @ ${DB_HOST}:${DB_PORT}"
    Write-Host ""

    $outFile = "$BACKUP_DIR\drivemate_full_$TIMESTAMP.sql"

    Write-Host "Creating full SQL backup..." -ForegroundColor Yellow

    & pg_dump `
        --host=$DB_HOST `
        --port=$DB_PORT `
        --username=$DB_USER `
        --dbname=$DB_NAME `
        --format=plain `
        --no-password `
        --clean `
        --if-exists `
        --schema=public `
        --file="$outFile" 2>&1 | ForEach-Object {
            Write-Host "  $_"
        }

    if (Test-Path $outFile) {
        $size = (Get-Item $outFile).Length / 1KB
        Write-Host ""
        Write-Host "Full backup complete!" -ForegroundColor Green
        Write-Host "   File : $outFile"
        Write-Host "   Size : $([math]::Round($size, 2)) KB"
    } else {
        Write-Host "Backup failed!" -ForegroundColor Red
        exit 1
    }

    # Export each table as CSV
    Write-Host ""
    Write-Host "Exporting individual tables as CSV..." -ForegroundColor Yellow

    $csvDir = "$BACKUP_DIR\csv_$TIMESTAMP"
    New-Item -ItemType Directory -Path $csvDir | Out-Null

    $success = 0
    $failed  = 0

    foreach ($table in $TABLES) {
        $csvFile = "$csvDir\$table.csv"
        $csvPath = $csvFile.Replace('\', '/')
        $query   = "\COPY public.`"$table`" TO '$csvPath' CSV HEADER"

        $result = & psql `
            --host=$DB_HOST `
            --port=$DB_PORT `
            --username=$DB_USER `
            --dbname=$DB_NAME `
            --no-password `
            --command=$query 2>&1

        if ($LASTEXITCODE -eq 0) {
            $rows = if (Test-Path $csvFile) { (Get-Content $csvFile).Count - 1 } else { 0 }
            Write-Host ("  OK  {0,-32} {1,6} rows" -f $table, $rows) -ForegroundColor Green
            $success++
        } else {
            Write-Host ("  SKIP {0,-32} {1}" -f $table, $result) -ForegroundColor Yellow
            $failed++
        }
    }

    Write-Host ""
    Write-Host "====================================" -ForegroundColor Cyan
    Write-Host "Summary" -ForegroundColor Cyan
    Write-Host "   Tables backed up : $success / $($TABLES.Count)"
    Write-Host "   Tables skipped   : $failed"
    Write-Host "   SQL backup       : $outFile"
    Write-Host "   CSV exports      : $csvDir"
    Write-Host ""
    Write-Host "To restore: .\backup.ps1 -Mode restore -BackupFile `"$outFile`"" -ForegroundColor Yellow
    Write-Host ""
}

# ── RESTORE ───────────────────────────────────────────────────
function Restore-Backup {
    if (-not $BackupFile -or -not (Test-Path $BackupFile)) {
        Write-Host "ERROR: Please provide a valid backup file path:" -ForegroundColor Red
        Write-Host "   .\backup.ps1 -Mode restore -BackupFile `"path\to\backup.sql`"" -ForegroundColor Yellow
        exit 1
    }

    Write-Host ""
    Write-Host "RESTORE MODE" -ForegroundColor Red
    Write-Host "====================================" -ForegroundColor Red
    Write-Host "   File     : $BackupFile"
    Write-Host "   Database : $DB_NAME @ ${DB_HOST}:${DB_PORT}"
    Write-Host ""
    $confirm = Read-Host "Type YES to confirm restore (this will overwrite existing data)"

    if ($confirm -ne "YES") {
        Write-Host "Restore cancelled." -ForegroundColor Yellow
        exit 0
    }

    Write-Host ""
    Write-Host "Restoring database..." -ForegroundColor Yellow

    & psql `
        --host=$DB_HOST `
        --port=$DB_PORT `
        --username=$DB_USER `
        --dbname=$DB_NAME `
        --no-password `
        --file="$BackupFile" 2>&1 | ForEach-Object {
            Write-Host "  $_"
        }

    Write-Host ""
    Write-Host "Restore complete!" -ForegroundColor Green
}

# ── ROW COUNT REPORT ──────────────────────────────────────────
function Row-Count-Report {
    Write-Host ""
    Write-Host "Database Row Count Report" -ForegroundColor Cyan
    Write-Host "====================================" -ForegroundColor Cyan
    Write-Host ""

    $totalRows = 0

    foreach ($table in $TABLES) {
        $count = & psql `
            --host=$DB_HOST `
            --port=$DB_PORT `
            --username=$DB_USER `
            --dbname=$DB_NAME `
            --no-password `
            --tuples-only `
            --command="SELECT COUNT(*) FROM public.`"$table`";" 2>&1

        $count = ($count -join "").Trim()
        if ($count -match '^\d+$') {
            $totalRows += [int]$count
            Write-Host ("  {0,-35} {1,8} rows" -f $table, $count)
        } else {
            Write-Host ("  {0,-35} ERROR" -f $table) -ForegroundColor Red
        }
    }

    Write-Host ""
    Write-Host ("  {0,-35} {1,8} rows TOTAL" -f "ALL TABLES", $totalRows) -ForegroundColor Cyan
    Write-Host ""
}

# ── Main ──────────────────────────────────────────────────────
Check-PgDump

switch ($Mode.ToLower()) {
    "full"    { Full-Backup; Row-Count-Report }
    "restore" { Restore-Backup }
    "report"  { Row-Count-Report }
    default   {
        Write-Host "Usage:"
        Write-Host "  .\backup.ps1                          # Full backup + row report"
        Write-Host "  .\backup.ps1 -Mode report             # Row counts only"
        Write-Host "  .\backup.ps1 -Mode restore -BackupFile path\to\file.sql"
    }
}
