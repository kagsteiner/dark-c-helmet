#!/bin/sh
# Builds the contribution server and copies it to the VPS, where pm2 runs it on 127.0.0.1:3060
# (DESIGN.md, "Contributions"); nginx maps /chess/api/ to it (see deploy/nginx.conf).
#
# Usage:  sh webapp/server/deploy.sh          (SERVER_TARGET, default vps:nodejs/chess-api)
#
# On the VPS:  ~/nodejs/chess-api/book-admin pending | approve <code> --user <name> | publish ...
set -e
: "${SERVER_TARGET:=vps:nodejs/chess-api}"
host=${SERVER_TARGET%%:*}
dir=${SERVER_TARGET#*:}
cd "$(dirname "$0")/.."
npm run server:build
printf '#!/bin/sh\nexec node "$(dirname "$0")/book-admin.mjs" "$@"\n' > server/dist/book-admin
chmod +x server/dist/book-admin
rsync -av --delete server/dist/ "$SERVER_TARGET/"
ssh "$host" "cd $dir && (pm2 restart chess-api || PORT=3060 pm2 start server.mjs --name chess-api) && pm2 save"
echo "Deployed to $SERVER_TARGET"
