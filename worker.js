
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

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/api/health") {
      return Response.json({
        status: "ok",
        service: "Vengeful Realms Enforcement",
        discordConfigured: Boolean(env.DISCORD_BOT_TOKEN),
        guildConfigured: Boolean(GUILD_ID),
        rolesConfigured: Object.keys(ROLES).length
      });
    }

    if (url.pathname.startsWith("/api/")) {
      return Response.json(
        { error: "Endpoint not available" },
        { status: 404 }
      );
    }

    return env.ASSETS.fetch(request);
  }
};
