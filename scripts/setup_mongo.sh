#!/bin/bash
set -e

# Configuration
MONGO_VERSION="7.0.14" # Using a recent 7.0.x stable
PLATFORM="macos-arm64" # Correct platform for Apple Silicon
URL="https://fastdl.mongodb.org/osx/mongodb-${PLATFORM}-${MONGO_VERSION}.tgz"
INSTALL_DIR="$HOME/.prd_agent/mongodb"
DATA_DIR="$HOME/.prd_agent/mongo_data"

# Ensure base directory exists
mkdir -p "$HOME/.prd_agent"

# Check for cleanup
rm -rf mongodb-*.tgz

echo "----------------------------------------------------------------"
echo "  Installing MongoDB Community Server ${MONGO_VERSION} (Lightweight)"
echo "----------------------------------------------------------------"

# 1. Download
echo "Downloading from: $URL"
curl -L -O "$URL"

# 2. Extract
echo "Extracting to: $INSTALL_DIR"
rm -rf "$INSTALL_DIR"
mkdir -p "$INSTALL_DIR"
tar -zxvf "mongodb-${PLATFORM}-${MONGO_VERSION}.tgz" -C "$INSTALL_DIR" --strip-components=1

# 3. Data Directory
echo "Creating data directory: $DATA_DIR"
mkdir -p "$DATA_DIR"

# 4. Create Launch Script
echo "Creating 'start_mongo.sh' convenience script..."
START_SCRIPT="$HOME/.prd_agent/start_mongo.sh"
cat > "$START_SCRIPT" <<EOF
#!/bin/bash
echo "Starting MongoDB..."
echo "  - Bin: $INSTALL_DIR/bin/mongod"
echo "  - Data: $DATA_DIR"
echo "  - Port: 27017"
echo ""
"$INSTALL_DIR/bin/mongod" --dbpath "$DATA_DIR" --bind_ip 127.0.0.1 --port 27017
EOF
chmod +x "$START_SCRIPT"

# 5. Cleanup
echo "Cleaning up archive..."
rm "mongodb-${PLATFORM}-${MONGO_VERSION}.tgz"

echo "----------------------------------------------------------------"
echo "SUCCESS!"
echo "----------------------------------------------------------------"
echo "You can now start MongoDB by running:"
echo "  $START_SCRIPT"
echo ""
echo "Note: This is a standalone binary install. It does not run as a system service."
