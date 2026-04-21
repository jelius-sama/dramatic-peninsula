#!/bin/bash

playerctl -p firefox metadata --follow --format "artist: {{artist}}|album: {{album}}|title: {{title}}|url: {{xesam:url}}" | grep --line-buffered "://apple.com"


# INFO: Example output
# $ playerctl -p firefox metadata --follow --format "artist: {{artist}}|album: {{album}}|title: {{title}}|url: {{xesam:url}}" | grep --line-buffered "://music.apple.com"
# artist: Rei MYSTH|album: |title: Harehare Ya mix ver. [ Kityod x keita x sou ]|url: https://music.apple.com/in/library/songs
# artist: Sou|album: |title: 【感情を込めて】ハレハレヤ 歌ってみた ver.Sou|url: https://music.apple.com/in/library/songs
# artist: Yuzaki Tsukasa (CV:Kitou Akari)|album: Yoruno Katasumi - Single|title: Yoruno Katasumi|url: https://music.apple.com/in/library/songs
