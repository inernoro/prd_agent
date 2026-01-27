#!/bin/bash
# PRD-Publish Quick Start Script
# Usage: ./quick.sh [command]
#
# Commands:
#   (none)    Start the server
#   dev       Start with watch mode
#   test      Run tests
#   install   Install dependencies
#   docker    Start with docker-compose

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

# Colors
CYAN='\033[0;36m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

# Check pnpm
check_pnpm() {
    if ! command -v pnpm &> /dev/null; then
        echo -e "${RED}Error: pnpm is not installed${NC}"
        echo "Install with: npm install -g pnpm"
        exit 1
    fi
}

# Check .env
check_env() {
    if [ ! -f ".env" ]; then
        echo -e "${YELLOW}Warning: .env not found, creating from template...${NC}"
        cp .env.example .env
        echo -e "${YELLOW}Please edit .env to set your password${NC}"
    fi
}

# Commands
cmd_install() {
    echo -e "${CYAN}Installing dependencies with pnpm...${NC}"
    check_pnpm
    pnpm install
    echo -e "${GREEN}Done!${NC}"
}

cmd_start() {
    check_pnpm
    check_env

    if [ ! -d "node_modules" ]; then
        echo -e "${YELLOW}node_modules not found, installing...${NC}"
        pnpm install
    fi

    echo -e "${CYAN}Starting PRD-Publish server...${NC}"
    pnpm start
}

cmd_dev() {
    check_pnpm
    check_env

    if [ ! -d "node_modules" ]; then
        pnpm install
    fi

    echo -e "${CYAN}Starting PRD-Publish in dev mode...${NC}"
    pnpm dev
}

cmd_test() {
    check_pnpm

    if [ ! -d "node_modules" ]; then
        pnpm install
    fi

    echo -e "${CYAN}Running tests...${NC}"
    pnpm test
}

cmd_docker() {
    if [ ! -f ".env" ]; then
        echo -e "${YELLOW}Warning: .env not found, creating from docker template...${NC}"
        cp .env.docker .env
        echo -e "${RED}Please edit .env to set required variables:${NC}"
        echo "  - PUBLISH_PASSWORD"
        echo "  - PUBLISH_JWT_SECRET"
        echo "  - HOST_REPO_PATH"
        exit 1
    fi

    echo -e "${CYAN}Starting with docker-compose...${NC}"
    docker-compose up -d
    echo -e "${GREEN}PRD-Publish is running at http://localhost:${PUBLISH_PORT:-3939}${NC}"
}

cmd_help() {
    echo ""
    echo -e "${CYAN}PRD-Publish Quick Start${NC}"
    echo ""
    echo "Usage: ./quick.sh [command]"
    echo ""
    echo "Commands:"
    echo "  (none)    Start the server"
    echo "  dev       Start with watch mode (auto-reload)"
    echo "  test      Run tests with coverage"
    echo "  install   Install dependencies"
    echo "  docker    Start with docker-compose"
    echo "  help      Show this help"
    echo ""
}

# Main
case "${1:-}" in
    "")
        cmd_start
        ;;
    "dev")
        cmd_dev
        ;;
    "test")
        cmd_test
        ;;
    "install")
        cmd_install
        ;;
    "docker")
        cmd_docker
        ;;
    "help"|"-h"|"--help")
        cmd_help
        ;;
    *)
        echo -e "${RED}Unknown command: $1${NC}"
        cmd_help
        exit 1
        ;;
esac
