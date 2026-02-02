#!/bin/bash
# Quick Start Script for PRD Publish + Executor Stack
# Usage: ./scripts/quickstart-publish.sh [option]
# Options:
#   dev      - Start in development mode (local, no Docker)
#   docker   - Start with Docker Compose
#   stop     - Stop Docker containers

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(dirname "$SCRIPT_DIR")"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

print_header() {
    echo -e "${BLUE}"
    echo "  ╔═══════════════════════════════════════════════════════════════╗"
    echo "  ║           PRD Publish + Executor Quick Start                  ║"
    echo "  ╚═══════════════════════════════════════════════════════════════╝"
    echo -e "${NC}"
}

print_step() {
    echo -e "${GREEN}[✓]${NC} $1"
}

print_warn() {
    echo -e "${YELLOW}[!]${NC} $1"
}

print_error() {
    echo -e "${RED}[✗]${NC} $1"
}

# Check dependencies
check_deps() {
    local missing=()

    if ! command -v node &> /dev/null; then
        missing+=("node")
    fi

    if ! command -v npm &> /dev/null; then
        missing+=("npm")
    fi

    if [ ${#missing[@]} -ne 0 ]; then
        print_error "Missing dependencies: ${missing[*]}"
        exit 1
    fi
}

# Development mode - run locally without Docker
dev_mode() {
    print_header
    echo -e "${YELLOW}Starting in Development Mode${NC}"
    echo ""

    check_deps

    # Install dependencies for executor
    print_step "Installing prd-executor dependencies..."
    cd "$ROOT_DIR/prd-executor"
    if [ ! -d "node_modules" ]; then
        npm install
    fi

    # Install dependencies for publish
    print_step "Installing prd-publish dependencies..."
    cd "$ROOT_DIR/prd-publish"
    if [ ! -d "node_modules" ]; then
        npm install
    fi

    # Create .env files if not exist
    if [ ! -f "$ROOT_DIR/prd-executor/.env" ]; then
        print_step "Creating prd-executor/.env from example..."
        cp "$ROOT_DIR/prd-executor/.env.example" "$ROOT_DIR/prd-executor/.env"
    fi

    if [ ! -f "$ROOT_DIR/prd-publish/.env" ]; then
        print_step "Creating prd-publish/.env from example..."
        cp "$ROOT_DIR/prd-publish/.env.example" "$ROOT_DIR/prd-publish/.env"
    fi

    echo ""
    echo -e "${GREEN}═══════════════════════════════════════════════════════════════${NC}"
    echo ""
    echo "  Ready to start! Run these commands in separate terminals:"
    echo ""
    echo -e "  ${BLUE}Terminal 1 (Executor):${NC}"
    echo "    cd $ROOT_DIR/prd-executor && npm run dev"
    echo ""
    echo -e "  ${BLUE}Terminal 2 (Publish):${NC}"
    echo "    cd $ROOT_DIR/prd-publish && npm run dev"
    echo ""
    echo -e "${GREEN}═══════════════════════════════════════════════════════════════${NC}"
    echo ""
    echo "  URLs:"
    echo "    - Executor Test Console: http://localhost:3940"
    echo "    - Publish UI:            http://localhost:3939"
    echo ""
    echo -e "  ${YELLOW}Note:${NC} MongoDB/Redis are optional in dev mode."
    echo "        Jobs won't be persisted without MongoDB."
    echo ""

    # Ask to start
    read -p "Start both services now? (y/n) " -n 1 -r
    echo ""
    if [[ $REPLY =~ ^[Yy]$ ]]; then
        # Start executor in background
        print_step "Starting prd-executor..."
        cd "$ROOT_DIR/prd-executor"
        npm run dev &
        EXECUTOR_PID=$!

        sleep 2

        # Start publish
        print_step "Starting prd-publish..."
        cd "$ROOT_DIR/prd-publish"
        npm run dev &
        PUBLISH_PID=$!

        echo ""
        print_step "Services started!"
        echo "    Executor PID: $EXECUTOR_PID"
        echo "    Publish PID:  $PUBLISH_PID"
        echo ""
        echo "  Press Ctrl+C to stop both services"

        # Wait and cleanup
        trap "kill $EXECUTOR_PID $PUBLISH_PID 2>/dev/null; exit" SIGINT SIGTERM
        wait
    fi
}

# Docker mode
docker_mode() {
    print_header
    echo -e "${YELLOW}Starting with Docker Compose${NC}"
    echo ""

    if ! command -v docker &> /dev/null; then
        print_error "Docker is not installed"
        exit 1
    fi

    if ! command -v docker-compose &> /dev/null && ! docker compose version &> /dev/null; then
        print_error "Docker Compose is not installed"
        exit 1
    fi

    cd "$ROOT_DIR"

    # Check for docker-compose command version
    if docker compose version &> /dev/null; then
        COMPOSE_CMD="docker compose"
    else
        COMPOSE_CMD="docker-compose"
    fi

    print_step "Building and starting containers..."
    $COMPOSE_CMD -f docker-compose.publish.yml up -d --build

    echo ""
    print_step "Waiting for services to be ready..."
    sleep 5

    echo ""
    echo -e "${GREEN}═══════════════════════════════════════════════════════════════${NC}"
    echo ""
    echo "  Services are running!"
    echo ""
    echo "  URLs:"
    echo "    - Executor Test Console: http://localhost:3940"
    echo "    - Publish UI:            http://localhost:3939"
    echo "    - MongoDB:               mongodb://localhost:27017"
    echo "    - Redis:                 redis://localhost:6379"
    echo ""
    echo "  Commands:"
    echo "    - View logs:  $COMPOSE_CMD -f docker-compose.publish.yml logs -f"
    echo "    - Stop:       $COMPOSE_CMD -f docker-compose.publish.yml down"
    echo ""
    echo -e "${GREEN}═══════════════════════════════════════════════════════════════${NC}"
}

# Stop Docker containers
stop_docker() {
    print_header
    echo -e "${YELLOW}Stopping Docker containers${NC}"
    echo ""

    cd "$ROOT_DIR"

    if docker compose version &> /dev/null; then
        COMPOSE_CMD="docker compose"
    else
        COMPOSE_CMD="docker-compose"
    fi

    $COMPOSE_CMD -f docker-compose.publish.yml down

    print_step "Containers stopped"
}

# Show help
show_help() {
    print_header
    echo "Usage: $0 [option]"
    echo ""
    echo "Options:"
    echo "  dev      Start in development mode (local, no Docker)"
    echo "  docker   Start with Docker Compose (includes Redis, MongoDB)"
    echo "  stop     Stop Docker containers"
    echo "  help     Show this help message"
    echo ""
    echo "Examples:"
    echo "  $0 dev       # Quick local development"
    echo "  $0 docker    # Full stack with Docker"
    echo ""
}

# Main
case "${1:-help}" in
    dev)
        dev_mode
        ;;
    docker)
        docker_mode
        ;;
    stop)
        stop_docker
        ;;
    help|--help|-h)
        show_help
        ;;
    *)
        print_error "Unknown option: $1"
        show_help
        exit 1
        ;;
esac
