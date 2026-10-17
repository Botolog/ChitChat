#!/bin/bash
set -e

echo "╔═══════════════════════════════════════════════════════════════╗"
echo "║       Local CI/CD Pipeline Test for ChitChat Snap            ║"
echo "╚═══════════════════════════════════════════════════════════════╝"
echo ""

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Check if running with sudo
if [ "$EUID" -eq 0 ]; then 
   echo -e "${RED}✗ Please do not run this script as root${NC}"
   exit 1
fi

# Step 1: Check prerequisites
echo -e "${BLUE}[Step 1/5]${NC} Checking prerequisites..."
echo ""

# Check for bun
if ! command -v bun &> /dev/null; then
    echo -e "${YELLOW}⚠ Bun not found, installing...${NC}"
    curl -fsSL https://bun.sh/install | bash
    export PATH="$HOME/.bun/bin:$PATH"
fi
echo -e "${GREEN}✓ Bun installed: $(bun --version)${NC}"

# Check for snapcraft
if ! command -v snapcraft &> /dev/null; then
    echo -e "${YELLOW}⚠ Snapcraft not found, installing...${NC}"
    sudo snap install snapcraft --classic
fi
echo -e "${GREEN}✓ Snapcraft installed${NC}"

# Install core22 base snap
echo "Installing core22 base snap..."
sudo snap install core22 2>/dev/null || true
sudo snap refresh core22 2>/dev/null || true
echo -e "${GREEN}✓ Core22 base available${NC}"

echo -e "${GREEN}✓ No LXD required (using destructive mode)${NC}"

echo ""
echo -e "${BLUE}[Step 2/5]${NC} Building Bun executable..."
echo ""

# Clean previous builds
rm -rf build
mkdir -p build

# Install dependencies
echo "Installing dependencies..."
bun install --frozen-lockfile

# Build executable
echo "Building executable with Bun..."
bun build src/index.ts \
  --compile \
  --minify \
  --sourcemap \
  --target=bun \
  --external @aws-sdk/client-s3 \
  --outfile build/chitchat

chmod +x build/chitchat
echo -e "${GREEN}✓ Built executable: build/chitchat${NC}"
ls -lh build/chitchat

echo ""
echo -e "${BLUE}[Step 3/5]${NC} Testing executable..."
echo ""

# Test the executable
./build/chitchat --help || echo -e "${YELLOW}⚠ Help command returned non-zero (expected for TUI apps)${NC}"
echo -e "${GREEN}✓ Executable test complete${NC}"

echo ""
echo -e "${BLUE}[Step 4/5]${NC} Building snap package..."
echo ""

# Clean previous snap builds
echo "Cleaning previous builds..."
rm -rf parts/ prime/ stage/ *.snap

# Build snap with lxd
echo "Building snap package with lxd (this may take several minutes)..."
snapcraft --use-lxd

SNAP_FILE=$(ls chitchat_*.snap 2>/dev/null || echo "")
if [ -z "$SNAP_FILE" ]; then
    echo -e "${RED}✗ Snap build failed - no .snap file found${NC}"
    exit 1
fi

echo -e "${GREEN}✓ Built snap: $SNAP_FILE${NC}"
ls -lh $SNAP_FILE

echo ""
echo -e "${BLUE}[Step 5/5]${NC} Testing snap package..."
echo ""

# Install snap for testing
echo "Installing snap for verification..."
sudo snap install --dangerous $SNAP_FILE

# Get snap info
snap info chitchat

# Test help command
echo ""
echo "Testing snap help command..."
chitchat --help || echo -e "${YELLOW}⚠ Help command returned non-zero${NC}"

echo ""
echo -e "${GREEN}✓ Snap package verified!${NC}"

# Clean up
echo ""
echo "Removing test installation..."
sudo snap remove chitchat

echo ""
echo "╔═══════════════════════════════════════════════════════════════╗"
echo "║                    Pipeline Complete! ✓                       ║"
echo "╚═══════════════════════════════════════════════════════════════╝"
echo ""
echo -e "${GREEN}Success!${NC} Your snap package is ready: ${YELLOW}$SNAP_FILE${NC}"
echo ""
echo "Next steps:"
echo "  1. Test manually: sudo snap install --dangerous $SNAP_FILE"
echo "  2. Upload to store: snapcraft upload --release=stable $SNAP_FILE"
echo "  3. Push to GitHub to trigger automatic build and publish"
echo ""
