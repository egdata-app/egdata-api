export const getDiscordUser = async (token: string) => {
  const discordResponse = await fetch("https://discord.com/api/v10/oauth2/@me", {
    headers: {
      Authorization: `Bearer ${token}`,
    },
  });

  if (!discordResponse.ok) {
    throw new Error(`Failed to fetch Discord user: ${discordResponse.status}`);
  }

  const discordJson = (await discordResponse.json()) as {
    user?: {
      id: string;
      email: string;
      username: string;
      avatar: string;
    };
  };

  const discordData = discordJson.user;

  if (!discordData) {
    console.error("Discord user data not found");
    return null;
  }

  return discordData as {
    id: string;
    email: string;
    username: string;
    avatar: string;
  };
};
