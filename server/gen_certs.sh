#!/bin/sh
set -e
mkdir -p certs
openssl req -x509 -newkey rsa:2048 -nodes \
  -keyout certs/server.key -out certs/server.crt -days 825 \
  -subj "/CN=phantom" \
  -addext "subjectAltName=IP:127.0.0.1,DNS:localhost"