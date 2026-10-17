#!/bin/bash
set -e

echo "Building chitchat with Bun..."

# Create build directory
mkdir -p build

# Bundle the application with Bun
bun build src/index.ts \
  --compile \
  --minify \
  --sourcemap \
  --target=bun \
  --external @aws-sdk/client-s3 \
  --outfile build/chitchat

echo "Build complete! Executable: build/chitchat"
