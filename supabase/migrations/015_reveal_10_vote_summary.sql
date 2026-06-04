create or replace function ww_vote_summary(p_players jsonb, p_votes jsonb)
returns jsonb
language sql
stable
as $$
  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'playerId', player_id,
        'playerName', player_name,
        'count', vote_count,
        'voters', voters
      )
      order by vote_count desc, player_name asc
    ),
    '[]'::jsonb
  )
  from (
    select
      player_json->>'id' as player_id,
      player_json->>'name' as player_name,
      (
        select count(*)::integer
        from jsonb_each_text(coalesce(p_votes, '{}'::jsonb)) as vote(voter_id, target_id)
        where vote.target_id = player_json->>'id'
      ) as vote_count,
      coalesce(
        (
          select jsonb_agg(ww_player_name(p_players, vote.voter_id::uuid) order by ww_player_name(p_players, vote.voter_id::uuid))
          from jsonb_each_text(coalesce(p_votes, '{}'::jsonb)) as vote(voter_id, target_id)
          where vote.target_id = player_json->>'id'
        ),
        '[]'::jsonb
      ) as voters
    from jsonb_array_elements(p_players) as player_json
  ) summary;
$$;

create or replace function ww_start_round(p_code text, p_player_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  room ww_rooms;
  pair ww_word_pairs;
  wolf_count integer;
  player_count integer;
  not_ready_count integer;
  shuffled_ids text[];
  wolf_ids text[];
  player_json jsonb;
  assignments jsonb := '{}'::jsonb;
  turn_order jsonb := '[]'::jsonb;
  is_wolf boolean;
  now_ms bigint := floor(extract(epoch from clock_timestamp()) * 1000);
begin
  select * into room from ww_rooms where code = upper(trim(p_code)) for update;
  if not found then
    raise exception '방을 찾을 수 없어요.';
  end if;
  if room.host_id <> p_player_id then
    raise exception '방장만 게임을 시작할 수 있어요.';
  end if;

  player_count := ww_player_count(room.players);
  if player_count < 3 then
    raise exception '워드울프는 최소 3명이 필요해요.';
  end if;

  select count(*)::integer
  into not_ready_count
  from jsonb_array_elements(room.players) as player
  where player->>'id' <> room.host_id::text
    and not coalesce((player->>'bot')::boolean, false)
    and not coalesce((player->>'ready')::boolean, false);

  if not_ready_count > 0 then
    raise exception '방장 제외 모두 준비 완료해야 시작할 수 있어요.';
  end if;

  select * into pair from ww_word_pairs order by random() limit 1;
  if pair.id is null then
    raise exception '단어 DB가 비어 있어요. Sync Word DB 액션을 먼저 실행해주세요.';
  end if;

  wolf_count := least(coalesce((room.settings->>'wolfCount')::integer, 1), greatest(1, player_count - 2));

  select array_agg(player_id order by sort_key), jsonb_agg(to_jsonb(player_id) order by sort_key)
  into shuffled_ids, turn_order
  from (
    select elem->>'id' as player_id, random() as sort_key
    from jsonb_array_elements(room.players) as elem
  ) picked;

  wolf_ids := shuffled_ids[1:wolf_count];

  for player_json in select * from jsonb_array_elements(room.players) loop
    is_wolf := (player_json->>'id') = any(wolf_ids);
    assignments := jsonb_set(
      assignments,
      array[player_json->>'id'],
      jsonb_build_object(
        'role', case when is_wolf then 'wolf' else 'villager' end,
        'word', case when is_wolf then pair.wolf else pair.villager end
      ),
      true
    );
  end loop;

  update ww_rooms
  set
    phase = 'reveal',
    round = room.round + 1,
    players = (
      select coalesce(jsonb_agg(player - 'ready'), '[]'::jsonb)
      from jsonb_array_elements(room.players) as player
    ),
    current_game = jsonb_build_object(
      'pair', jsonb_build_object('villager', pair.villager, 'wolf', pair.wolf, 'category', pair.category),
      'wolfIds', to_jsonb(wolf_ids),
      'assignments', assignments,
      'turnOrder', turn_order,
      'hintIndex', 0,
      'hints', '{}'::jsonb,
      'votes', '{}'::jsonb,
      'startedAt', now_ms,
      'phaseEndsAt', now_ms + 10 * 1000,
      'activePlayerId', null,
      'result', null,
      'wolfGuess', null
    ),
    updated_at = now()
  where code = room.code
  returning * into room;

  return ww_room_state(room, p_player_id);
end;
$$;

create or replace function ww_finish_vote(room ww_rooms)
returns ww_rooms
language plpgsql
security definer
set search_path = public
as $$
declare
  top_score integer := 0;
  top_count integer := 0;
  eliminated_id text;
  wolf_ids text[];
  caught_wolf boolean := false;
  vote_summary jsonb;
  result jsonb;
  updated_room ww_rooms;
begin
  vote_summary := ww_vote_summary(room.players, coalesce(room.current_game->'votes', '{}'::jsonb));

  select target, score
  into eliminated_id, top_score
  from (
    select value as target, count(*)::integer as score
    from jsonb_each_text(coalesce(room.current_game->'votes', '{}'::jsonb))
    group by value
    order by score desc
    limit 1
  ) ranked;

  if top_score is null then
    eliminated_id := null;
  else
    select count(*)
    into top_count
    from (
      select value as target, count(*)::integer as score
      from jsonb_each_text(coalesce(room.current_game->'votes', '{}'::jsonb))
      group by value
    ) scores
    where score = top_score;

    if top_count <> 1 then
      eliminated_id := null;
    end if;
  end if;

  select array_agg(value::text)
  into wolf_ids
  from jsonb_array_elements_text(room.current_game->'wolfIds');

  caught_wolf := eliminated_id is not null and eliminated_id = any(wolf_ids);

  if caught_wolf then
    return ww_set_phase(
      room,
      'wolf_guess',
      30,
      eliminated_id,
      jsonb_build_object('eliminatedId', eliminated_id)
    );
  end if;

  result := jsonb_build_object(
    'eliminatedId', eliminated_id,
    'tie', eliminated_id is null,
    'winners', 'wolves',
    'reason', case when eliminated_id is null then 'tie' else 'vote_missed_wolf' end,
    'words', jsonb_build_object(
      'villager', room.current_game->'pair'->>'villager',
      'wolf', room.current_game->'pair'->>'wolf'
    ),
    'wolves', to_jsonb(wolf_ids),
    'voteSummary', vote_summary
  );

  update ww_rooms
  set
    phase = 'result',
    current_game = jsonb_set(room.current_game, '{result}', result, true),
    updated_at = now()
  where code = room.code
  returning * into updated_room;

  return updated_room;
end;
$$;

create or replace function ww_submit_wolf_guess(p_code text, p_player_id uuid, p_guess text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  room ww_rooms;
  clean_guess text := left(trim(coalesce(p_guess, '')), 40);
  correct boolean;
  wolf_ids text[];
  result jsonb;
begin
  select * into room from ww_rooms where code = upper(trim(p_code)) for update;
  if not found then
    raise exception '방을 찾을 수 없어요.';
  end if;
  if room.phase <> 'wolf_guess' then
    raise exception '지금은 울프 단어 추리 시간이 아니에요.';
  end if;
  if room.current_game->>'activePlayerId' <> p_player_id::text then
    raise exception '지목된 울프만 정답을 입력할 수 있어요.';
  end if;

  correct := lower(clean_guess) = lower(room.current_game->'pair'->>'villager');

  select array_agg(value::text)
  into wolf_ids
  from jsonb_array_elements_text(room.current_game->'wolfIds');

  result := jsonb_build_object(
    'eliminatedId', room.current_game->>'eliminatedId',
    'tie', false,
    'winners', case when correct then 'wolves' else 'villagers' end,
    'reason', case when correct then 'wolf_guessed_word' else 'wolf_missed_word' end,
    'words', jsonb_build_object(
      'villager', room.current_game->'pair'->>'villager',
      'wolf', room.current_game->'pair'->>'wolf'
    ),
    'wolves', to_jsonb(wolf_ids),
    'guess', clean_guess,
    'guessCorrect', correct,
    'voteSummary', ww_vote_summary(room.players, coalesce(room.current_game->'votes', '{}'::jsonb))
  );

  update ww_rooms
  set
    phase = 'result',
    current_game = jsonb_set(
      jsonb_set(room.current_game, '{wolfGuess}', to_jsonb(clean_guess), true),
      '{result}',
      result,
      true
    ),
    updated_at = now()
  where code = room.code
  returning * into room;

  return ww_room_state(room, p_player_id);
end;
$$;

notify pgrst, 'reload schema';
