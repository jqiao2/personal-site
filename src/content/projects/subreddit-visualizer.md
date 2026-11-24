---
title: Subreddit Visualizer
description: A network graph of subreddits, linked by how they mention each other.
repoUrl: https://github.com/jqiao2/SubredditVisualizer
date: 2018-05-26
tags: [data viz, reddit]
---

Uses PRAW, GephiStreamer, and Sigma.js to map (almost) all subreddits on Reddit, connecting them by
mentions in each subreddit's description and submit text. A scraper recursively pulls subreddit
metadata, a grapher builds weighted edges between mentioned subreddits and streams them to a Gephi
server, and the largest connected component is laid out with ForceAtlas2.
