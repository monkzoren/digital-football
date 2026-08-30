#!/bin/sh
set -e
SERVER_URL="${SPACETIMEDB_URL:-http://spacetimedb:3000}"
DB_NAME="${DATABASE_NAME:-digital-football}"
# The server's token-signing key, shared read-only via the spacetimedb-data
# volume (the server writes it there on first boot — see docker-compose.yml).
SERVER_KEY="${SERVER_KEY:-/stdb/keys/id_ecdsa}"
# FIXED claims: SpacetimeDB derives an identity purely from iss|sub, so a
# token minted with these claims is the SAME identity — the database owner —
# on every deploy. Don't change them once a database exists, or the publisher
# becomes a different identity that doesn't own it.
MINT_ISSUER="digital-football-publisher"

echo "Waiting for SpacetimeDB at $SERVER_URL ..."
until curl -sf "$SERVER_URL/v1/ping" > /dev/null 2>&1; do
  sleep 2
done

# Establish the publishing identity, most robust option first:
#   1. SPACETIME_TOKEN — explicit owner token, pins ownership across machines.
#   2. Mint a token from the server's signing key with fixed claims — the
#      deterministic owner identity; survives every redeploy and re-key.
#   3. Whatever identity is saved in the publisher-creds volume (legacy).
login_publisher() {
  if [ -n "$SPACETIME_TOKEN" ]; then
    echo "Logging in with SPACETIME_TOKEN ..."
    spacetime login --token "$SPACETIME_TOKEN"
    return
  fi
  # The server writes its key before it starts listening, so after ping the
  # key should exist; wait briefly in case the volume is slow to propagate.
  tries=0
  while [ ! -f "$SERVER_KEY" ] && [ $tries -lt 5 ]; do
    tries=$((tries + 1)); sleep 1
  done
  if [ -f "$SERVER_KEY" ]; then
    echo "Minting deterministic publisher identity from the server key ..."
    TOKEN=$(node /mint-token.mjs "$SERVER_KEY" "$MINT_ISSUER" "$DB_NAME")
    spacetime login --token "$TOKEN"
  else
    echo "WARNING: server key not found at $SERVER_KEY — the spacetimedb"
    echo "service is probably missing the --jwt-priv-key-path flag in its"
    echo "command. Falling back to the identity in the publisher-creds"
    echo "volume, which does NOT survive server re-keys."
  fi
}
login_publisher

echo "Publishing module '$DB_NAME' to $SERVER_URL as:"
spacetime login show || true

# One publish attempt; output is echoed AND kept in PUBLISH_OUT so failure
# handling can branch on the reason. Extra args (--clear-database) pass through.
try_publish() {
  PUBLISH_OUT=$(spacetime publish "$DB_NAME" --server "$SERVER_URL" --module-path /module "$@" -y 2>&1)
  PUBLISH_RC=$?
  echo "$PUBLISH_OUT"
  return $PUBLISH_RC
}

# A publish that clears the database used to be harmless: every row here died
# with the room that owned it. Since accounts landed it is DATA LOSS — real
# players' XP, MMR and history — so it now takes an explicit opt-in.
clear_blocked() {
  echo
  echo "PUBLISH REJECTED, and clearing the database is NOT automatic anymore."
  echo
  echo "The 'account' table holds persistent player progress (level, XP, MMR,"
  echo "match history). --clear-database would delete all of it."
  echo
  echo "This is almost always a BREAKING SCHEMA CHANGE. SpacetimeDB migrates"
  echo "automatically only for APPENDED columns with defaults — reordering,"
  echo "removing or retyping a column is breaking. Fix the schema so the"
  echo "change is append-only and publish again."
  echo
  echo "Back up first, from a machine that can reach the server:"
  echo "  spacetime sql $DB_NAME 'SELECT * FROM account' > accounts.bak"
  echo
  echo "If you have genuinely decided to discard all player progress:"
  echo "  ALLOW_CLEAR=1  (env var on the publisher) and redeploy."
  exit 1
}

publish_failed() {
  echo
  echo "PUBLISH FAILED. If the error says 'not authorized ... update database',"
  echo "the database was created by an identity this publisher can no longer"
  echo "become — typically a database created BEFORE key persistence and"
  echo "deterministic publisher identity were set up (its owner's identity"
  echo "died with an old server re-key). That is unrecoverable via the API:"
  echo "  - if you have the owner's token: set SPACETIME_TOKEN to it and"
  echo "    redeploy (print it on a host that owns the DB:"
  echo "    spacetime login show --token), or"
  echo "  - start over, losing all game state: delete the spacetimedb-data"
  echo "    volume and redeploy. Coolify: Storages -> delete the volume."
  echo "    Compose CLI: docker compose down -v && docker compose up -d --build"
  echo "  This is a ONE-TIME reset; from then on the publisher's identity is"
  echo "  deterministic and every redeploy stays the owner."
  if [ -n "$SPACETIME_TOKEN" ]; then
    echo
    echo "NOTE: SPACETIME_TOKEN is set. 'spacetime login --token' accepts any"
    echo "string without checking it, so a wrong value fails here, not above."
    echo "Unless you are deliberately pinning ownership, leave it empty and"
    echo "let the publisher mint the owner identity from the server key."
  fi
  exit 1
}

if ! try_publish; then
  if echo "$PUBLISH_OUT" | grep -q "InvalidSignature"; then
    # The token's signature no longer matches the server's key (the server
    # re-keyed since the token was created). Re-mint/re-login and retry —
    # with a minted token this recovers the SAME identity under the new key.
    echo "Server rejected the token (InvalidSignature) — refreshing"
    echo "credentials against the current server key and retrying..."
    rm -f /root/.config/spacetime/cli.toml
    login_publisher
    if ! try_publish; then
      [ -n "$ALLOW_CLEAR" ] || clear_blocked
      echo "Publish rejected — ALLOW_CLEAR is set, clearing database and retrying..."
      try_publish --clear-database || publish_failed
    fi
  else
    [ -n "$ALLOW_CLEAR" ] || clear_blocked
    echo "Publish rejected (breaking schema change?) — ALLOW_CLEAR is set,"
    echo "clearing database and retrying..."
    try_publish --clear-database || publish_failed
  fi
fi
echo "Module published."

# Stay alive so orchestrators (Coolify etc.) see the whole app as healthy —
# an exited one-shot container can gate proxy routing.
echo "Publisher idle; module is live."
exec tail -f /dev/null
