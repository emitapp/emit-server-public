#Expected pwd: project root

echo "🔥🔥🔥"
echo "You are about to deploy to: "
projectname=$(firebase use)
BOLD=$(tput bold)
NORMAL=$(tput sgr0)
YELLOW='\033[1;33m' 
NC='\033[0m' # No Color
echo "${YELLOW}${BOLD}${projectname}${NC}${NORMAL}"
echo "🔥🔥🔥"

read -p "Do you wish to continue? " -n 1 -r
echo    # move to a new line
if [[ ! $REPLY =~ ^[Yy]$ ]]
then
# handle exits from shell or function but don't exit interactive shell
    [[ "$0" = "$BASH_SOURCE" ]] && exit 1 || return 1 
fi
