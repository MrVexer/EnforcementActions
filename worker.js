
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
  ["operations_manager", "head_of_enforcement", "enforcement_captain"].includes(role)
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
    "head_of_enforcement",
    "enforcement_captain"
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


    // Section 2: server-authorized, audited shared infraction records.
    if (url.pathname === "/api/infractions" || url.pathname.startsWith("/api/infractions/")) {
      const collection = url.pathname === "/api/infractions";
      const allowed = collection ? ["GET", "POST"] : ["PUT", "DELETE"];
      if (!allowed.includes(request.method)) return json({error:"Method not allowed"},405);
      try {
        const auth = await verifyStaff(request,env);
        if (!auth.ok) return auth;
        const staff = await auth.json();
        const roles = staff.roles || [];
        const managers = ["operations_manager","head_of_enforcement"];
        const editors = [...managers,"enforcement_captain","enforcement_officer"];
        const readers = [...editors,"trial_enforcement","support_team"];
        const canView = roles.some(role=>readers.includes(role));
        const canEdit = roles.some(role=>editors.includes(role));
        const canDelete = roles.some(role=>managers.includes(role));
        if (!staff.authorized || (request.method==="GET" ? !canView :
            request.method==="DELETE" ? !canDelete : !canEdit)) {
          return json({error:"Insufficient permissions"},403);
        }
        if (!env.SUPABASE_SECRET_KEY) return json({error:"Database unavailable"},503);
        const headers = {
          apikey:env.SUPABASE_SECRET_KEY,
          "Content-Type":"application/json",
          Accept:"application/json"
        };
        if (request.method==="GET") {
          const response = await fetch(
            `${SUPABASE_URL}/rest/v1/vr_infractions?select=id,record,updated_at&order=updated_at.desc&limit=200`,
            {headers,cache:"no-store"}
          );
          if (!response.ok) return json({error:"Unable to load infractions"},503);
          return json({success:true,infractions:await response.json()});
        }

        const id = collection ? crypto.randomUUID() :
          decodeURIComponent(url.pathname.slice("/api/infractions/".length));
        if (!/^[0-9a-f]{8}-[0-9a-f-]{27,36}$/i.test(id)) {
          return json({error:"Invalid infraction ID"},400);
        }
        const raw = await request.text();
        if (new TextEncoder().encode(raw).length>32768) return json({error:"Request too large"},413);
        let input;
        try { input=JSON.parse(raw); } catch { return json({error:"Invalid JSON"},400); }
        if (!input || typeof input!=="object" || Array.isArray(input)) {
          return json({error:"Invalid infraction data"},400);
        }
        let expected;
        if (!collection) {
          expected=input.expectedUpdatedAt;
          if (typeof expected!=="string" || !/^\d{4}-\d{2}-\d{2}T/.test(expected) ||
              !Number.isFinite(Date.parse(expected))) {
            return json({error:"Missing or invalid record version"},400);
          }
        }

        const apiError = async response => {
          const error=await response.json().catch(()=>({}));
          if (error.code==="P0001") return json({error:"This infraction changed. Refresh before editing."},409);
          if (error.code==="P0002") return json({error:error.message||"Record not found"},404);
          if (error.code==="P0003") return json({error:"This infraction has linked punishments and cannot be deleted."},409);
          if (error.code==="23505") return json({error:"Duplicate infraction ID"},409);
          console.error("Infraction database error:",response.status,error.code);
          return json({error:"Infraction database operation failed"},503);
        };
        const rpc = async (name,params) => {
          const response=await fetch(`${SUPABASE_URL}/rest/v1/rpc/${name}`,{
            method:"POST",headers,body:JSON.stringify(params),cache:"no-store"
          });
          if (!response.ok) return apiError(response);
          return json(await response.json(),request.method==="POST"?201:200);
        };
        if (request.method==="DELETE") {
          return rpc("vr_delete_infraction",{
            p_id:id,p_actor_discord_id:staff.discordId,
            p_actor_username:staff.username,p_expected_updated_at:expected
          });
        }

        const limits = {
          player:64,type:150,severity:20,date:10,officer:120,status:30,
          description:8000,investigationNotes:8000,assignedOfficer:120,
          investigationStage:40,casePriority:20,investigationFindings:8000,
          caseOutcome:40,resolutionNotes:8000,resolutionDate:10,evidence:8000
        };
        const fields={};
        for (const [key,max] of Object.entries(limits)) {
          if (typeof input[key]!=="string") return json({error:`Invalid ${key}`},400);
          fields[key]=input[key].trim();
          if (fields[key].length>max) return json({error:`Field too long: ${key}`},400);
        }
        if (!/^[0-9a-f]{8}-[0-9a-f-]{27,36}$/i.test(fields.player)) {
          return json({error:"Select a valid shared player"},400);
        }
        if (!fields.type) return json({error:"Rule violated is required"},400);
        const validOptions = {
          severity:["Low","Moderate","High","Critical"],
          status:["Open","Investigating","Resolved","Dismissed"],
          investigationStage:["Reported","Assigned","Investigating","Pending Review","Closed"],
          casePriority:["Low","Normal","High","Urgent"],
          caseOutcome:["Undetermined","Substantiated","Unsubstantiated","Inconclusive","Withdrawn"]
        };
        for (const [key,options] of Object.entries(validOptions)) {
          if (!options.includes(fields[key])) return json({error:`Invalid ${key}`},400);
        }
        for (const key of ["date","resolutionDate"]) {
          if (fields[key] && !/^\d{4}-\d{2}-\d{2}$/.test(fields[key])) {
            return json({error:`Invalid ${key}`},400);
          }
        }

        let record;
        if (collection) {
          record={id,...fields,createdAt:new Date().toISOString()};
        } else {
          const response=await fetch(
            `${SUPABASE_URL}/rest/v1/vr_infractions?id=eq.${encodeURIComponent(id)}&select=id,record&limit=1`,
            {headers,cache:"no-store"}
          );
          if (!response.ok) return json({error:"Unable to load infraction"},503);
          const rows=await response.json();
          if (!rows.length) return json({error:"Infraction not found"},404);
          record={...rows[0].record,id,...fields};
        }
        return rpc(collection?"vr_create_infraction":"vr_update_infraction",{
          p_id:id,p_record:record,
          p_actor_discord_id:staff.discordId,p_actor_username:staff.username,
          ...(collection?{}:{p_expected_updated_at:expected})
        });
      } catch (error) {
        console.error("Infraction API error:",error);
        return json({error:"Infraction service temporarily unavailable"},503);
      }
    }

    // Section 3: shared punishments with server-side role enforcement.
    if (url.pathname === "/api/punishments" || url.pathname.startsWith("/api/punishments/")) {
      const collection=url.pathname==="/api/punishments";
      if (!(collection ? ["GET","POST"] : ["PUT","DELETE"]).includes(request.method))
        return json({error:"Method not allowed"},405);
      try {
        const verified=await verifyStaff(request,env);
        if (!verified.ok) return verified;
        const staff=await verified.json();
        const roles=staff.roles||[];
        const managers=["operations_manager","head_of_enforcement"];
        const editors=[...managers,"enforcement_captain","enforcement_officer"];
        const readers=[...editors,"trial_enforcement","support_team"];
        const permitted=request.method==="GET"?readers:request.method==="DELETE"?managers:editors;
        if (!staff.authorized || !roles.some(r=>permitted.includes(r)))
          return json({error:"Insufficient permissions"},403);
        if (!env.SUPABASE_SECRET_KEY) return json({error:"Database unavailable"},503);
        const headers={apikey:env.SUPABASE_SECRET_KEY,"Content-Type":"application/json",Accept:"application/json"};
        if (request.method==="GET") {
          const result=await fetch(`${SUPABASE_URL}/rest/v1/vr_punishments?select=id,record,updated_at&order=updated_at.desc&limit=200`,{headers,cache:"no-store"});
          if (!result.ok) return json({error:"Unable to load punishments"},503);
          return json({success:true,punishments:await result.json()});
        }
        const id=collection?crypto.randomUUID():decodeURIComponent(url.pathname.slice("/api/punishments/".length));
        if (!/^[0-9a-f]{8}-[0-9a-f-]{27,36}$/i.test(id)) return json({error:"Invalid punishment ID"},400);
        const raw=await request.text();
        if (new TextEncoder().encode(raw).length>32768) return json({error:"Request too large"},413);
        let input;
        try {input=JSON.parse(raw)} catch {return json({error:"Invalid JSON"},400)}
        if (!input || typeof input!=="object" || Array.isArray(input)) return json({error:"Invalid payload"},400);
        const expected=input.expectedUpdatedAt;
        if (!collection && (typeof expected!=="string" || !/^\d{4}-\d{2}-\d{2}T/.test(expected) || !Number.isFinite(Date.parse(expected))))
          return json({error:"Invalid record version"},400);
        const dbError=async response=>{
          const detail=await response.json().catch(()=>({}));
          if (detail.code==="P0001") return json({error:"This punishment changed. Refresh before editing."},409);
          if (detail.code==="P0002") return json({error:detail.message||"Linked record not found"},404);
          if (detail.code==="P0003") return json({error:"Linked appeals prevent deletion"},409);
          console.error("Punishment RPC failed",response.status,detail.code);
          return json({error:"Punishment database operation failed"},503);
        };
        const rpc=async(name,params)=>{
          const result=await fetch(`${SUPABASE_URL}/rest/v1/rpc/${name}`,{
            method:"POST",headers,body:JSON.stringify(params),cache:"no-store"
          });
          return result.ok?json(await result.json(),request.method==="POST"?201:200):dbError(result);
        };
        const actor={p_actor_discord_id:staff.discordId,p_actor_username:staff.username};
        if (request.method==="DELETE") return rpc("vr_delete_punishment",{
          p_id:id,...actor,p_expected_updated_at:expected
        });
        const limits={player:64,infraction:64,action:30,duration:150,expiresAt:10,
          status:20,officer:120,date:10,notes:8000};
        const fields={};
        for (const [key,max] of Object.entries(limits)) {
          if (typeof input[key]!=="string") return json({error:`Invalid ${key}`},400);
          fields[key]=input[key].trim();
          if (fields[key].length>max) return json({error:`Field too long: ${key}`},400);
        }
        const uuid=/^[0-9a-f]{8}-[0-9a-f-]{27,36}$/i;
        if (!uuid.test(fields.player) || (fields.infraction && !uuid.test(fields.infraction)))
          return json({error:"Choose a valid shared player and infraction"},400);
        if (!["Verbal Warning","Written Warning","Kick","Temporary Ban","Permanent Ban"].includes(fields.action))
          return json({error:"Invalid punishment action"},400);
        if (!["Active","Expired","Revoked"].includes(fields.status)) return json({error:"Invalid status"},400);
        if (!fields.notes) return json({error:"Reason / notes is required"},400);
        for (const key of ["date","expiresAt"])
          if (fields[key] && !/^\d{4}-\d{2}-\d{2}$/.test(fields[key])) return json({error:`Invalid ${key}`},400);
        if (fields.action==="Temporary Ban" && (!fields.expiresAt || !fields.date || fields.expiresAt<=fields.date))
          return json({error:"Temporary bans require an expiry date after the issue date"},400);
        if (fields.action!=="Temporary Ban" && fields.expiresAt)
          return json({error:"Only temporary bans can have an expiry date"},400);
        if (!fields.date) return json({error:"Issue date is required"},400);
        let record;
        if (collection) {
          record={id,...fields,issuedByDiscordId:staff.discordId,createdAt:new Date().toISOString()};
        } else {
          const response=await fetch(`${SUPABASE_URL}/rest/v1/vr_punishments?id=eq.${encodeURIComponent(id)}&select=id,record&limit=1`,{headers,cache:"no-store"});
          if (!response.ok) return json({error:"Unable to load punishment"},503);
          const rows=await response.json();
          if (!rows.length) return json({error:"Punishment not found"},404);
          record={...rows[0].record,id,...fields};
        }
        return rpc(collection?"vr_create_punishment":"vr_update_punishment",{
          p_id:id,p_record:record,...actor,...(collection?{}:{p_expected_updated_at:expected})
        });
      } catch(error) {
        console.error("Punishment API failure",error);
        return json({error:"Punishment service unavailable"},503);
      }
    }

    // Section 4: shared ban appeals. Decision permissions are enforced server-side.
    if (url.pathname === "/api/appeals" || url.pathname.startsWith("/api/appeals/")) {
      const collection=url.pathname==="/api/appeals";
      if (!(collection?["GET","POST"]:["PUT","DELETE"]).includes(request.method))
        return json({error:"Method not allowed"},405);
      try {
        const verified=await verifyStaff(request,env);
        if (!verified.ok) return verified;
        const staff=await verified.json();
        const roles=staff.roles||[];
        const managers=["operations_manager","head_of_enforcement"];
        const reviewers=[...managers,"enforcement_captain"];
        const readers=[...reviewers,"enforcement_officer","trial_enforcement","support_team"];
        const permitted=request.method==="GET"?readers:request.method==="DELETE"?managers:reviewers;
        if (!staff.authorized || !roles.some(role=>permitted.includes(role)))
          return json({error:"Insufficient permissions"},403);
        if (!env.SUPABASE_SECRET_KEY) return json({error:"Database unavailable"},503);
        const headers={apikey:env.SUPABASE_SECRET_KEY,"Content-Type":"application/json",Accept:"application/json"};
        if (request.method==="GET") {
          const response=await fetch(`${SUPABASE_URL}/rest/v1/vr_appeals?select=id,record,updated_at&order=updated_at.desc&limit=200`,{headers,cache:"no-store"});
          if (!response.ok) return json({error:"Unable to load appeals"},503);
          return json({success:true,appeals:await response.json()});
        }
        const id=collection?crypto.randomUUID():decodeURIComponent(url.pathname.slice("/api/appeals/".length));
        if (!/^[0-9a-f]{8}-[0-9a-f-]{27,36}$/i.test(id)) return json({error:"Invalid appeal ID"},400);
        const raw=await request.text();
        if (new TextEncoder().encode(raw).length>32768) return json({error:"Request too large"},413);
        let input;
        try {input=JSON.parse(raw)} catch {return json({error:"Invalid JSON"},400)}
        if (!input || typeof input!=="object" || Array.isArray(input)) return json({error:"Invalid appeal payload"},400);
        const expected=input.expectedUpdatedAt;
        if (!collection && (typeof expected!=="string" || !/^\d{4}-\d{2}-\d{2}T/.test(expected) || !Number.isFinite(Date.parse(expected))))
          return json({error:"Invalid record version"},400);
        const rpcError=async response=>{
          const detail=await response.json().catch(()=>({}));
          if (detail.code==="P0001") return json({error:"This appeal changed. Refresh before editing."},409);
          if (["P0002","P0003"].includes(detail.code)) return json({error:detail.message||"Appeal validation failed"},409);
          console.error("Appeal RPC failed",response.status,detail.code,detail.message);
          // Diagnostic only: the caller has already passed Discord staff verification.
          // Do not expose SQL details or credentials in this response.
          return json({error:"Appeal database operation failed"},503);
        };
        const rpc=async(name,params)=>{
          const response=await fetch(`${SUPABASE_URL}/rest/v1/rpc/${name}`,{method:"POST",headers,body:JSON.stringify(params),cache:"no-store"});
          return response.ok?json(await response.json(),request.method==="POST"?201:200):rpcError(response);
        };
        const actor={p_actor_discord_id:staff.discordId,p_actor_username:staff.username};
        if (request.method==="DELETE") return rpc("vr_delete_appeal",{p_id:id,...actor,p_expected_updated_at:expected});
        const limits={player:64,punishment:64,submittedAt:10,appellant:120,statement:8000,
          status:30,reviewNotes:8000,decisionReason:8000};
        const fields={};
        for (const [key,max] of Object.entries(limits)) {
          if (typeof input[key]!=="string") return json({error:`Invalid ${key}`},400);
          fields[key]=input[key].trim();
          if (fields[key].length>max) return json({error:`Field too long: ${key}`},400);
        }
        const uuid=/^[0-9a-f]{8}-[0-9a-f-]{27,36}$/i;
        if (!uuid.test(fields.player) || !uuid.test(fields.punishment))
          return json({error:"Choose a player and their linked ban"},400);
        if (!fields.statement) return json({error:"Appeal statement is required"},400);
        if (!/^\d{4}-\d{2}-\d{2}$/.test(fields.submittedAt)) return json({error:"Invalid submission date"},400);
        if (!["Pending","Under Review","Approved","Denied"].includes(fields.status))
          return json({error:"Invalid appeal status"},400);
        if (collection && fields.status!=="Pending") return json({error:"New appeals must begin as Pending"},400);
        if (["Approved","Denied"].includes(fields.status) && !fields.decisionReason)
          return json({error:"Decision reason is required"},400);
        let record;
        if (collection) {
          record={id,...fields,createdAt:new Date().toISOString()};
        } else {
          const response=await fetch(`${SUPABASE_URL}/rest/v1/vr_appeals?id=eq.${encodeURIComponent(id)}&select=id,record&limit=1`,{headers,cache:"no-store"});
          if (!response.ok) return json({error:"Unable to load appeal"},503);
          const rows=await response.json();
          if (!rows.length) return json({error:"Appeal not found"},404);
          record={...rows[0].record,id,...fields};
        }
        return rpc(collection?"vr_create_appeal":"vr_update_appeal",{
          p_id:id,p_record:record,...actor,...(collection?{}:{p_expected_updated_at:expected})
        });
      } catch(error) {
        console.error("Appeal API failure",error);
        return json({error:"Appeal service unavailable"},503);
      }
    }

    // Section 5: shared staff directory. Never grants or changes Discord roles.
    if (url.pathname === "/api/staff" || url.pathname.startsWith("/api/staff/")) {
      const collection=url.pathname==="/api/staff";
      if (!(collection?["GET","POST"]:["PUT","DELETE"]).includes(request.method))
        return json({error:"Method not allowed"},405);
      try {
        const auth=await verifyStaff(request,env);
        if (!auth.ok) return auth;
        const staff=await auth.json();
        const roles=staff.roles||[];
        const editors=["operations_manager","head_of_enforcement"];
        const readers=[...editors,"enforcement_captain","enforcement_officer","trial_enforcement","support_team"];
        const allowed=request.method==="GET"?readers:editors;
        if (!staff.authorized || !roles.some(role=>allowed.includes(role)))
          return json({error:"Insufficient permissions"},403);
        if (!env.SUPABASE_SECRET_KEY) return json({error:"Database unavailable"},503);
        const headers={apikey:env.SUPABASE_SECRET_KEY,"Content-Type":"application/json",Accept:"application/json"};
        if (request.method==="GET") {
          const response=await fetch(`${SUPABASE_URL}/rest/v1/vr_staff?select=id,record,updated_at&order=updated_at.desc&limit=500`,{headers,cache:"no-store"});
          if (!response.ok) return json({error:"Unable to load staff directory"},503);
          return json({success:true,staff:await response.json()});
        }
        const id=collection?crypto.randomUUID():decodeURIComponent(url.pathname.slice("/api/staff/".length));
        const uuid=/^[0-9a-f]{8}-[0-9a-f-]{27,36}$/i;
        if (!uuid.test(id)) return json({error:"Invalid staff record ID"},400);
        const raw=await request.text();
        if (new TextEncoder().encode(raw).length>16384) return json({error:"Request too large"},413);
        let input;
        try {input=JSON.parse(raw)} catch {return json({error:"Invalid JSON"},400)}
        if (!input || typeof input!=="object" || Array.isArray(input)) return json({error:"Invalid staff payload"},400);
        const expected=input.expectedUpdatedAt;
        if (!collection && (typeof expected!=="string" || !Number.isFinite(Date.parse(expected))))
          return json({error:"Invalid record version"},400);
        const actor={p_actor_discord_id:staff.discordId,p_actor_username:staff.username};
        const rpc=async(name,params)=>{
          const response=await fetch(`${SUPABASE_URL}/rest/v1/rpc/${name}`,{method:"POST",headers,body:JSON.stringify(params),cache:"no-store"});
          if (response.ok) return json(await response.json(),request.method==="POST"?201:200);
          const detail=await response.json().catch(()=>({}));
          if (detail.code==="P0001") return json({error:"This staff record changed. Refresh and try again."},409);
          if (detail.code==="P0002") return json({error:"Staff record not found"},404);
          if (detail.code==="23505") return json({error:"This Discord ID is already registered"},409);
          console.error("Staff RPC error",response.status,detail.code);
          return json({error:"Staff database operation failed"},503);
        };
        if (request.method==="DELETE") return rpc("vr_archive_staff",{p_id:id,...actor,p_expected_updated_at:expected});
        const limits={name:100,discordId:20,role:40,status:20,team:80,joinedAt:10,notes:4000};
        const fields={};
        for (const [key,max] of Object.entries(limits)) {
          if (typeof input[key]!=="string" || input[key].length>max) return json({error:`Invalid ${key}`},400);
          fields[key]=input[key].trim();
        }
        if (!fields.name) return json({error:"Staff name is required"},400);
        if (fields.discordId && !/^\d{17,20}$/.test(fields.discordId)) return json({error:"Discord ID must be 17–20 digits"},400);
        if (!["Operations Manager","Head of Enforcement","Enforcement Captain","Enforcement Officer","Trial Enforcement","Support Team","Story Team"].includes(fields.role))
          return json({error:"Invalid staff role"},400);
        if (!["Active","On Leave","Inactive","Archived"].includes(fields.status)) return json({error:"Invalid status"},400);
        if (fields.joinedAt && !/^\d{4}-\d{2}-\d{2}$/.test(fields.joinedAt)) return json({error:"Invalid join date"},400);
        let record;
        if (collection) record={id,...fields,createdAt:new Date().toISOString()};
        else {
          const response=await fetch(`${SUPABASE_URL}/rest/v1/vr_staff?id=eq.${encodeURIComponent(id)}&select=id,record&limit=1`,{headers,cache:"no-store"});
          if (!response.ok) return json({error:"Unable to load staff record"},503);
          const rows=await response.json();
          if (!rows.length) return json({error:"Staff record not found"},404);
          record={...rows[0].record,id,...fields};
        }
        return rpc(collection?"vr_create_staff":"vr_update_staff",{p_id:id,p_record:record,...actor,...(collection?{}:{p_expected_updated_at:expected})});
      } catch(error) {console.error("Staff API error",error);return json({error:"Staff service unavailable"},503)}
    }


    // Section 6: shared staff tasks.
    if (url.pathname === "/api/tasks" || url.pathname.startsWith("/api/tasks/")) {
      const collection=url.pathname==="/api/tasks";
      if (!(collection?["GET","POST"]:["PUT","DELETE"]).includes(request.method))
        return json({error:"Method not allowed"},405);
      try {
        const auth=await verifyStaff(request,env);
        if (!auth.ok) return auth;
        const staff=await auth.json();
        const roles=staff.roles||[];
        const readers=["operations_manager","head_of_enforcement","enforcement_captain",
          "enforcement_officer","trial_enforcement","support_team"];
        const editors=["operations_manager","head_of_enforcement","enforcement_captain"];
        const allowed=request.method==="GET"?readers:editors;
        if (!staff.authorized || !roles.some(role=>allowed.includes(role)))
          return json({error:"Insufficient permissions"},403);
        if (!env.SUPABASE_SECRET_KEY) return json({error:"Database unavailable"},503);
        const headers={apikey:env.SUPABASE_SECRET_KEY,"Content-Type":"application/json",Accept:"application/json"};
        if (request.method==="GET") {
          const response=await fetch(`${SUPABASE_URL}/rest/v1/vr_tasks?select=id,record,updated_at&order=updated_at.desc&limit=500`,{headers,cache:"no-store"});
          if (!response.ok) return json({error:"Unable to load shared tasks"},503);
          return json({success:true,tasks:await response.json()});
        }
        const id=collection?crypto.randomUUID():decodeURIComponent(url.pathname.slice("/api/tasks/".length));
        const uuid=/^[0-9a-f]{8}-[0-9a-f-]{27,36}$/i;
        if (!uuid.test(id)) return json({error:"Invalid task ID"},400);
        const raw=await request.text();
        if (new TextEncoder().encode(raw).length>16000) return json({error:"Request too large"},413);
        let input;try{input=JSON.parse(raw)}catch{return json({error:"Invalid JSON"},400)}
        if (!input || typeof input!=="object" || Array.isArray(input))return json({error:"Invalid task data"},400);
        const expected=input.expectedUpdatedAt;
        if (!collection && (typeof expected!=="string" || !Number.isFinite(Date.parse(expected))))
          return json({error:"Invalid record version"},400);
        const actor={p_actor_discord_id:staff.discordId,p_actor_username:staff.username};
        const rpc=async(name,params)=>{
          const response=await fetch(`${SUPABASE_URL}/rest/v1/rpc/${name}`,{
            method:"POST",headers,body:JSON.stringify(params),cache:"no-store"});
          if(response.ok)return json(await response.json(),request.method==="POST"?201:200);
          const detail=await response.json().catch(()=>({}));
          if(detail.code==="P0001")return json({error:"Task was changed by someone else. Refresh and try again."},409);
          if(detail.code==="P0002")return json({error:detail.message||"Task or assigned staff not found"},404);
          console.error("Task RPC failed",response.status,detail.code,detail.message);
          return json({error:"Task database operation failed"},503);
        };
        if(request.method==="DELETE")return rpc("vr_archive_task",{p_id:id,...actor,p_expected_updated_at:expected});
        const limits={title:160,description:8000,assignedTo:64,priority:20,status:30,dueDate:10};
        const fields={};
        for(const [key,max] of Object.entries(limits)){
          if(typeof input[key]!=="string" || input[key].length>max)
            return json({error:`Invalid ${key}`},400);
          fields[key]=input[key].trim();
        }
        if(!fields.title)return json({error:"Task title is required"},400);
        if(fields.assignedTo && !uuid.test(fields.assignedTo))return json({error:"Invalid assigned staff ID"},400);
        if(!["Low","Medium","High","Critical"].includes(fields.priority))return json({error:"Invalid priority"},400);
        if(!["To Do","In Progress","Completed"].includes(fields.status))return json({error:"Invalid status"},400);
        if(fields.dueDate && !/^\d{4}-\d{2}-\d{2}$/.test(fields.dueDate))
          return json({error:"Invalid due date"},400);
        let record;
        const now=new Date().toISOString();
        if(collection)record={id,...fields,createdAt:now,completedAt:fields.status==="Completed"?now:null,archived:false};
        else {
          const response=await fetch(`${SUPABASE_URL}/rest/v1/vr_tasks?id=eq.${encodeURIComponent(id)}&select=id,record&limit=1`,{headers,cache:"no-store"});
          if(!response.ok)return json({error:"Unable to load task"},503);
          const rows=await response.json();
          if(!rows.length)return json({error:"Task not found"},404);
          record={...rows[0].record,id,...fields,completedAt:fields.status==="Completed"?(rows[0].record.completedAt||now):null};
        }
        return rpc(collection?"vr_create_task":"vr_update_task",{
          p_id:id,p_record:record,...actor,...(collection?{}:{p_expected_updated_at:expected})});
      }catch(error){console.error("Task API error",error);return json({error:"Task service unavailable"},503)}
    }

    // Section 7: shared documents and revision history.
    if (url.pathname === "/api/documents" || url.pathname.startsWith("/api/documents/")) {
      const collection=url.pathname==="/api/documents";
      const pathTail=collection?"":url.pathname.slice("/api/documents/".length);
      const revisionRoute=pathTail.endsWith("/revisions");
      const id=collection?"":decodeURIComponent(revisionRoute?pathTail.slice(0,-10):pathTail);
      const uuid=/^[0-9a-f]{8}-[0-9a-f-]{27,36}$/i;
      if (!collection&&!uuid.test(id))return json({error:"Invalid document ID"},400);
      if (!(collection?["GET","POST"]:revisionRoute?["GET"]:["PUT","DELETE"]).includes(request.method))
        return json({error:"Method not allowed"},405);
      try {
        const auth=await verifyStaff(request,env);
        if(!auth.ok)return auth;
        const staff=await auth.json();
        const roles=staff.roles||[];
        const managers=["operations_manager","head_of_enforcement"];
        const editors=[...managers,"enforcement_captain"];
        const readers=[...editors,"enforcement_officer","trial_enforcement","support_team"];
        const allowed=request.method==="GET"?readers:request.method==="DELETE"?managers:editors;
        if(!staff.authorized||!roles.some(role=>allowed.includes(role)))return json({error:"Insufficient permissions"},403);
        if(!env.SUPABASE_SECRET_KEY)return json({error:"Database unavailable"},503);
        const headers={apikey:env.SUPABASE_SECRET_KEY,"Content-Type":"application/json",Accept:"application/json"};
        if(request.method==="GET"){
          const endpoint=revisionRoute?
            `${SUPABASE_URL}/rest/v1/vr_document_revisions?document_id=eq.${encodeURIComponent(id)}&select=revision,record,actor_username,created_at&order=revision.desc&limit=100`:
            `${SUPABASE_URL}/rest/v1/vr_documents?select=id,record,updated_at&order=updated_at.desc&limit=500`;
          const response=await fetch(endpoint,{headers,cache:"no-store"});
          if(!response.ok)return json({error:"Unable to load documents"},503);
          const rows=await response.json();
          return json({success:true,[revisionRoute?"revisions":"documents"]:rows});
        }
        const raw=await request.text();
        if(new TextEncoder().encode(raw).length>45000)return json({error:"Request too large"},413);
        let input;try{input=JSON.parse(raw)}catch{return json({error:"Invalid JSON"},400)}
        if(!input||typeof input!=="object"||Array.isArray(input))return json({error:"Invalid document data"},400);
        const expected=input.expectedUpdatedAt;
        if(!collection&&(typeof expected!=="string"||!Number.isFinite(Date.parse(expected))))return json({error:"Invalid document version"},400);
        const actor={p_actor_discord_id:staff.discordId,p_actor_username:staff.username};
        const rpc=async(name,params)=>{
          const response=await fetch(`${SUPABASE_URL}/rest/v1/rpc/${name}`,{
            method:"POST",headers,body:JSON.stringify(params),cache:"no-store"});
          if(response.ok)return json(await response.json(),request.method==="POST"?201:200);
          const detail=await response.json().catch(()=>({}));
          if(detail.code==="P0001")return json({error:"Document changed. Refresh before editing."},409);
          if(detail.code==="P0002")return json({error:"Document not found"},404);
          console.error("Document RPC failed",response.status,detail.code,detail.message);
          return json({error:"Document database operation failed"},503);
        };
        const newId=collection?crypto.randomUUID():id;
        let previous=null;
        if(!collection){
          const response=await fetch(`${SUPABASE_URL}/rest/v1/vr_documents?id=eq.${encodeURIComponent(id)}&select=id,record&limit=1`,{headers,cache:"no-store"});
          if(!response.ok)return json({error:"Unable to load document"},503);
          const rows=await response.json();
          if(!rows.length)return json({error:"Document not found"},404);
          previous=rows[0].record;
        }
        if(request.method==="DELETE"){
          const record={...previous,status:"Archived",archivedAt:new Date().toISOString()};
          return rpc("vr_update_document",{p_id:id,p_record:record,...actor,p_expected_updated_at:expected});
        }
        const limits={title:180,category:80,description:1500,content:30000,url:2000,status:20};
        const fields={};
        for(const [key,max] of Object.entries(limits)){
          if(typeof input[key]!=="string"||input[key].length>max)return json({error:`Invalid ${key}`},400);
          fields[key]=input[key].trim();
        }
        if(!fields.title)return json({error:"Document title is required"},400);
        if(!fields.content&&!fields.url)return json({error:"Provide document content or a URL"},400);
        if(!["Draft","Published","Archived"].includes(fields.status))return json({error:"Invalid document status"},400);
        if(fields.url){try{const parsed=new URL(fields.url);if(!["https:","http:"].includes(parsed.protocol))throw Error()}catch{return json({error:"Document URL must be an http(s) address"},400)}}
        if(fields.status==="Archived"&&!roles.some(role=>managers.includes(role)))return json({error:"Only senior management can archive documents"},403);
        if(previous?.status==="Archived"&&!roles.some(role=>managers.includes(role)))return json({error:"Only senior management can edit archived documents"},403);
        const now=new Date().toISOString();
        const record=collection?{id:newId,...fields,revision:1,createdAt:now,createdByDiscordId:staff.discordId,createdBy:staff.username}:
          {...previous,...fields,id:newId,updatedByDiscordId:staff.discordId,updatedBy:staff.username};
        return rpc(collection?"vr_create_document":"vr_update_document",{
          p_id:newId,p_record:record,...actor,...(collection?{}:{p_expected_updated_at:expected})});
      }catch(error){console.error("Document API error",error);return json({error:"Document service unavailable"},503)}
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
