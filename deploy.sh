#!/bin/sh
set -eu

cd "$(dirname "$0")"

if [ ! -f ".env" ]; then
  echo "Missing .env. Run: cp .env.example .env, then add your credentials."
  exit 1
fi

required_keys="APP_USERNAME APP_PASSWORD SESSION_SECRET GEMINI_API_KEY REPLICATE_API_TOKEN"
missing_keys=""
for key in $required_keys; do
  value=$(grep -E "^${key}=" .env | tail -n 1 | cut -d "=" -f 2- || true)
  if [ -z "$value" ]; then
    missing_keys="$missing_keys $key"
  fi
done
if [ -n "$missing_keys" ]; then
  echo "Missing required values in .env:$missing_keys"
  exit 1
fi

command -v docker >/dev/null 2>&1 || { echo "Docker is not installed."; exit 1; }
docker info >/dev/null 2>&1 || { echo "Docker is installed but the daemon is not running."; exit 1; }

echo "Pulling the latest Bella's Studio build..."
git pull --ff-only origin main

echo "Building and restarting Bella's Studio..."
docker compose up -d --build --remove-orphans

echo "Deployment complete."
docker compose ps