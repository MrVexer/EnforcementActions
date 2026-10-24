
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

    if (url.pathname.startsWith("/api/")) {
      return json(
        { error: "Endpoint not available" },
        404
      );
    }

    return env.ASSETS.fetch(request);
  }
};
