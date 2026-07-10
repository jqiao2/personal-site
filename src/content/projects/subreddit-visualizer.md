---
title: Subreddit Visualizer
description: Maps subreddit relationships on Reddit into a Gephi network graph using PRAW and GephiStreamer.
repoUrl: https://github.com/jqiao2/SubredditVisualizer
date: 2018-05-26
tags: [python, reddit, graph, gephi]
---

Uses PRAW, GephiStreamer, and Sigma.js to map (almost) all subreddits on Reddit, connecting them by
mentions in each subreddit's description and submit text. A scraper recursively pulls subreddit
metadata, a grapher builds weighted edges between mentioned subreddits and streams them to a Gephi
server, and the largest connected component is laid out with ForceAtlas2.
