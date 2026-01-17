export interface Videos {
  kind: string;
  etag: string;
  nextPageToken?: string;
  items: Array<{
    kind: string;
    etag: string;
    id: string;
    snippet: {
      publishedAt: string;
      channelId: string;
      title: string;
      description: string;
      thumbnails: {
        default: { url: string; width: number; height: number };
        medium: { url: string; width: number; height: number };
        high: { url: string; width: number; height: number };
        standard?: { url: string; width: number; height: number };
        maxres?: { url: string; width: number; height: number };
      };
      channelTitle: string;
      playlistId: string;
      position: number;
      resourceId: {
        kind: string;
        videoId: string;
      };
      videoOwnerChannelTitle: string;
      videoOwnerChannelId: string;
    };
    contentDetails: {
      videoId: string;
      videoPublishedAt: string;
    };
  }>;
  pageInfo: {
    totalResults: number;
    resultsPerPage: number;
  };
}

export async function getYouTubeVideos(opts: {
  access_token: string;
  playlistId: string;
}): Promise<Videos | null> {
  const { access_token, playlistId } = opts;

  try {
    const res = await fetch(
      `https://www.googleapis.com/youtube/v3/playlistItems?part=snippet,contentDetails&playlistId=${playlistId}&maxResults=30`,
      {
        headers: {
          Authorization: `Bearer ${access_token}`,
          "Content-Type": "application/json",
        },
      },
    );

    if (!res.ok) {
      const err = await res.text();
      console.error("Fetch videos failed:", err);
      return null;
    }

    return (await res.json()) as Videos;
  } catch (error) {
    console.error("Something went wrong:", error);
    return null;
  }
}
