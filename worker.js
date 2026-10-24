
const GUILD_ID = "1504150182663819264";

const ROLES = {
  operations_manager: "1552973300685348955",
  head_of_enforcement: "1508054798136512562",
  enforcement_captain: "1508050725823975434",
  enforcement_officer: "1508051854016381050",
  trial_enforcement: "1550681021563801721",
  support_team: "1508052216102125698",
  story_team: "1524025305860407358"
};

const SUPABASE_URL =
  "https://jhkvaxvqfoqvihnkqkxz.supabase.co";

const SUPABASE_KEY =
  "sb_publishable_rDmQRDZFbzczUCSvy4KutQ_FA9csd6I";

const json = (data, status = 200) =>
  Response.json(data, {
    status,
    headers: {
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff"
    }
  });

async function verifyStaff(request, env) {
  const authorization =
    request.headers.get("Authorization") || "";

  if (!authorization.startsWith("Bearer ")) {
    return json({
      authorized: false,
      error: "Missing login token"
    }, 401);
  }

  const token = authorization.slice(7).trim();

  if (!token || token.length > 8192) {
    return json({
      authorized: false,
      error: "Invalid login token"
    }, 401);
  }

  if (!env.DISCORD_BOT_TOKEN) {
    return json({
      authorized: false,
      error: "Discord verification unavailable"
    }, 503);
  }

  // Validate the session with Supabase Auth.
  const authResponse = await fetch(
    `${SUPABASE_URL}/auth/v1/user`,
    {
      headers: {
        "apikey": SUPABASE_KEY,
        "Authorization": `Bearer ${token}`
      }
    }
  );

  if (!authResponse.ok) {
    return json({
      authorized: false,
      error: "Invalid or expired session"
    }, 401);
  }

  const user = await authResponse.json();

  // Use the linked OAuth provider identity,
  // not editable profile metadata.
 const discordIdentity = user.identities?.find(
  identity => identity.provider === "discord"
);

const discordId = String(
  discordIdentity?.provider_id ||
  discordIdentity?.identity_data?.provider_id ||
  discordIdentity?.identity_data?.sub ||
  discordIdentity?.identity_data?.id ||
  ""
);

  if (!discordId || !/^\d{17,20}$/.test(discordId)) {
    return json({
      authorized: false,
      error: "No verified Discord identity"
    }, 403);
  }

  // Retrieve membership directly from Discord.
  const discordResponse = await fetch(
    `https://discord.com/api/v10/guilds/${GUILD_ID}/members/${discordId}`,
    {
      headers: {
        "Authorization": `Bot ${env.DISCORD_BOT_TOKEN}`
      }
    }
  );

  if (discordResponse.status === 404) {
    return json({
      authorized: false,
      error: "Not a member of Vengeful Realms"
    }, 403);
  }

  if (!discordResponse.ok) {
    console.error(
      "Discord membership lookup failed:",
      discordResponse.status
    );

    return json({
      authorized: false,
      error: "Discord role verification unavailable"
    }, 503);
  }

  const member = await discordResponse.json();

  if (member.pending === true) {
    return json({
      authorized: false,
      error: "Discord membership screening incomplete"
    }, 403);
  }

  const memberRoles = Array.isArray(member.roles)
    ? member.roles
    : [];

  const matchedRoles = Object.entries(ROLES)
    .filter(([, id]) => memberRoles.includes(id))
    .map(([name]) => name);

  if (matchedRoles.length === 0) {
    return json({
      authorized: false,
      error: "No authorised staff role"
    }, 403);
  }

  return json({
    authorized: true,
    discordId,
    username:
      member.user?.username ||
      user.user_metadata?.name ||
      "Unknown",
    primaryRole: matchedRoles[0],
    roles: matchedRoles
  });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/api/health") {
      return json({
        status: "ok",
        service: "Vengeful Realms Enforcement",
        discordConfigured: Boolean(env.DISCORD_BOT_TOKEN),
        guildConfigured: Boolean(GUILD_ID),
        rolesConfigured: Object.keys(ROLES).length
      });
    }

    if (url.pathname === "/api/auth/verify") {
      if (request.method !== "GET") {
        return json(
          { error: "Method not allowed" },
          405
        );
      }

      try {
        return await verifyStaff(request, env);
      } catch (error) {
        console.error("Role verification error:", error);

        return json({
          authorized: false,
          error: "Verification temporarily unavailable"
        }, 503);
      }
    }

        // Protected, read-only database connection test.
    if (url.pathname === "/api/db/status") {
      if (request.method !== "GET") {
        return json(
          { error: "Method not allowed" },
          405
        );
      }

      // Reuse our existing server-side Discord
      // identity and staff role verification.
      let verificationResponse;

      try {
        verificationResponse = await verifyStaff(request, env);
      } catch (error) {
        console.error("Authentication error:", error);

        return json({
          authorized: false,
          error: "Authentication unavailable"
        }, 503);
      }

      if (!verificationResponse.ok) {
        return verificationResponse;
      }

      const verification =
        await verificationResponse.json();

      if (verification.authorized !== true) {
        return json({
          authorized: false,
          error: "Access denied"
        }, 403);
      }

      if (!env.SUPABASE_SECRET_KEY) {
        return json({
          error: "Database configuration unavailable"
        }, 503);
      }

      try {
        // Request zero records: tests the database
        // connection without returning player data.
        const dbResponse = await fetch(
          `${SUPABASE_URL}/rest/v1/vr_players?select=id&limit=0`,
          {
            method: "GET",
            headers: {
              "apikey": env.SUPABASE_SECRET_KEY,
              "Accept": "application/json"
            },
            cache: "no-store"
          }
        );

        if (!dbResponse.ok) {
          console.error(
            "Supabase connection failed:",
            dbResponse.status
          );

          return json({
            authorized: true,
            database: "error",
            error: "Database connection failed"
          }, 503);
        }

        return json({
          authorized: true,
          database: "connected",
          role: verification.primaryRole,
          message: "Protected database connection successful"
        });

      } catch (error) {
        console.error("Database request error:", error);

        return json({
          authorized: true,
          database: "error",
          error: "Database unavailable"
        }, 503);
      }
    }

        // STEP 19B: Secure player editing
    // PUT /api/players/{player-id}
    if (url.pathname.startsWith("/api/players/")) {
      if (request.method !== "PUT") {
        return json({ error: "Method not allowed" }, 405);
      }

      const playerId = decodeURIComponent(
        url.pathname.slice("/api/players/".length)
      );

      if (!/^[0-9a-f]{8}-[0-9a-f-]{27,36}$/i.test(playerId)) {
        return json({ error: "Invalid player ID" }, 400);
      }

      try {
        // Verify the session and Discord membership.
        const authResponse = await verifyStaff(request, env);
        if (!authResponse.ok) return authResponse;

        const staff = await authResponse.json();

        // Temporary restriction: Operations Managers only.
        if (
          staff.authorized !== true ||
          !staff.roles?.some(role =>
  ["operations_manager", "head_of_enforcement"].includes(role)
)
        ) {
          return json({ error: "Insufficient permissions" }, 403);
        }

        if (!env.SUPABASE_SECRET_KEY) {
          return json({ error: "Database unavailable" }, 503);
        }

        // Limit incoming request size.
        const bodyText = await request.text();

        if (new TextEncoder().encode(bodyText).length > 16384) {
          return json({ error: "Request too large" }, 413);
        }

        let input;
        try {
          input = JSON.parse(bodyText);
        } catch {
          return json({ error: "Invalid JSON" }, 400);
        }

        if (
          !input ||
          typeof input !== "object" ||
          Array.isArray(input)
        ) {
          return json({ error: "Invalid player data" }, 400);
        }

        if (
          typeof input.expectedUpdatedAt !== "string" ||
          !/^\d{4}-\d{2}-\d{2}T/.test(input.expectedUpdatedAt) ||
          !Number.isFinite(Date.parse(input.expectedUpdatedAt))
        ) {
          return json({
            error: "Missing or invalid record version"
          }, 400);
        }

        // Only accept the four editable player fields.
        for (const field of ["name", "discord", "characters", "notes"]) {
          if (typeof input[field] !== "string") {
            return json({
              error: `Invalid ${field} field`
            }, 400);
          }
        }

        const name = input.name.trim();
        const discord = input.discord.trim();
        const characters = input.characters.trim();
        const notes = input.notes.trim();

        if (!name || name.length > 100) {
          return json({ error: "Invalid player name" }, 400);
        }

        if (discord && !/^\d{17,20}$/.test(discord)) {
          return json({ error: "Invalid Discord ID" }, 400);
        }

        if (characters.length > 2000 || notes.length > 5000) {
          return json({ error: "Player details too long" }, 400);
        }

        const headers = {
          apikey: env.SUPABASE_SECRET_KEY,
          "Content-Type": "application/json",
          Accept: "application/json"
        };

        // Read the current record to preserve its
        // server-controlled and additional existing fields.
        const readResponse = await fetch(
          `${SUPABASE_URL}/rest/v1/vr_players` +
          `?id=eq.${encodeURIComponent(playerId)}` +
          `&select=id,record,updated_at&limit=1`,
          {
            method: "GET",
            headers,
            cache: "no-store"
          }
        );

        if (!readResponse.ok) {
          console.error("Player lookup failed:", readResponse.status);
          return json({ error: "Unable to load player" }, 503);
        }

        const rows = await readResponse.json();

        if (rows.length === 0) {
          return json({ error: "Player not found" }, 404);
        }

        const existing = rows[0];

        const updatedPlayer = {
          ...existing.record,
          id: existing.id,
          name,
          discord,
          characters,
          notes
        };

        // Atomic update and audit log transaction.
        const updateResponse = await fetch(
          `${SUPABASE_URL}/rest/v1/rpc/vr_update_player`,
          {
            method: "POST",
            headers,
            body: JSON.stringify({
              p_id: playerId,
              p_record: updatedPlayer,
              p_actor_discord_id: staff.discordId,
              p_actor_username: staff.username,
              p_expected_updated_at: input.expectedUpdatedAt
            }),
            cache: "no-store"
          }
        );

        if (!updateResponse.ok) {
          const dbError = await updateResponse.json()
            .catch(() => ({}));

          if (dbError.code === "P0001" &&
    dbError.message === "Player was modified by another user") {
            return json({
              error: "This player was changed by another staff member. Refresh before editing."
            }, 409);
          }

          if (dbError.code === "P0002") {
            return json({ error: "Player not found" }, 404);
          }

          if (dbError.code === "23505") {
            return json({
              error: "A player with this Discord ID already exists"
            }, 409);
          }

          if (dbError.code === "23514") {
            return json({
              error: "Player data failed database validation"
            }, 400);
          }

          console.error(
            "Player update failed:",
            updateResponse.status,
            dbError.code
          );

          return json({ error: "Unable to update player" }, 503);
        }

        const result = await updateResponse.json();

        return json({
          success: true,
          player: updatedPlayer,
          updated_at: result.updated_at
        });

      } catch (error) {
        console.error("Player editing error:", error);
        return json({
          error: "Player editing temporarily unavailable"
        }, 503);
      }
    }

        // STEP 14: Secure Player Database - read-only test
    // Secure Player Database: read and create
    if (url.pathname === "/api/players") {
      if (!["GET", "POST"].includes(request.method)) {
        return json({ error: "Method not allowed" }, 405);
      }

      try {
        const authResponse = await verifyStaff(request, env);

        if (!authResponse.ok) return authResponse;

        const staff = await authResponse.json();

        const canViewPlayers = staff.roles?.some(role =>
  [
    "operations_manager",
    "head_of_enforcement",
    "enforcement_captain",
    "enforcement_officer",
    "trial_enforcement",
    "support_team"
  ].includes(role)
);

const canManagePlayers = staff.roles?.some(role =>
  [
    "operations_manager",
    "head_of_enforcement"
  ].includes(role)
);

if (
  staff.authorized !== true ||
  (request.method === "GET"
    ? !canViewPlayers
    : !canManagePlayers)
) {
  return json({ error: "Insufficient permissions" }, 403);
}

        if (!env.SUPABASE_SECRET_KEY) {
          return json({ error: "Database unavailable" }, 503);
        }

        const dbHeaders = {
          apikey: env.SUPABASE_SECRET_KEY,
          "Content-Type": "application/json",
          Accept: "application/json"
        };

        if (request.method === "GET") {
          const response = await fetch(
            `${SUPABASE_URL}/rest/v1/vr_players?select=id,record,updated_at&order=updated_at.desc&limit=50`,
            {
              headers: dbHeaders,
              cache: "no-store"
            }
          );

          if (!response.ok) {
            console.error("Player read failed:", response.status);
            return json({ error: "Unable to load players" }, 503);
          }

          const players = await response.json();

          return json({
            success: true,
            players,
            count: players.length
          });
        }

        // POST: create a player
        const contentLength = Number(
          request.headers.get("Content-Length") || 0
        );

        if (contentLength > 16384) {
          return json({ error: "Request too large" }, 413);
        }

        const rawBody = await request.text();

        if (rawBody.length > 16384) {
          return json({ error: "Request too large" }, 413);
        }

        let input;

        try {
          input = JSON.parse(rawBody);
        } catch {
          return json({ error: "Invalid JSON" }, 400);
        }

        if (
          !input ||
          typeof input !== "object" ||
          Array.isArray(input)
        ) {
          return json({ error: "Invalid player data" }, 400);
        }

        const name =
          typeof input.name === "string"
            ? input.name.trim()
            : "";

        const discord =
          typeof input.discord === "string"
            ? input.discord.trim()
            : "";

        const characters =
          typeof input.characters === "string"
            ? input.characters.trim()
            : "";

        const notes =
          typeof input.notes === "string"
            ? input.notes.trim()
            : "";

        if (!name || name.length > 100) {
          return json({ error: "Invalid player name" }, 400);
        }

        if (
          discord &&
          !/^[0-9]{17,20}$/.test(discord)
        ) {
          return json({ error: "Invalid Discord ID" }, 400);
        }

        if (characters.length > 2000 || notes.length > 5000) {
          return json({ error: "Player details too long" }, 400);
        }

        const playerId = crypto.randomUUID();

        const player = {
          id: playerId,
          name,
          discord,
          characters,
          notes,
          createdAt: new Date().toISOString()
        };

        const response = await fetch(
          `${SUPABASE_URL}/rest/v1/rpc/vr_create_player`,
          {
            method: "POST",
            headers: dbHeaders,
            body: JSON.stringify({
              p_id: playerId,
              p_record: player,
              p_actor_discord_id: staff.discordId,
              p_actor_username: staff.username
            }),
            cache: "no-store"
          }
        );

        if (!response.ok) {
          const errorText = await response.text();

          // PostgreSQL unique constraint violation.
          if (errorText.includes('"23505"')) {
            return json({
              error: "A player with this Discord ID already exists"
            }, 409);
          }

          console.error("Player creation failed:", response.status);
          return json({ error: "Unable to create player" }, 503);
        }

        return json({
          success: true,
          player
        }, 201);

      } catch (error) {
        console.error("Player API error:", error);

        return json({
          error: "Player Database temporarily unavailable"
        }, 503);
      }
    }

    if (url.pathname.startsWith("/api/")) {
      return json(
        { error: "Endpoint not available" },
        404
      );
    }

    return env.ASSETS.fetch(request);
  }
};
