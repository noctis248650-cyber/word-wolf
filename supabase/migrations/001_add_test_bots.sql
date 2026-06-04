create or replace function ww_room_state(room ww_rooms, viewer_id uuid)
returns jsonb
language plpgsql
stable
as $$
declare
  game jsonb := room.current_game;
  player jsonb;
  players_json jsonb := '[]'::jsonb;
  viewer_assignment jsonb;
begin
  for player in select * from jsonb_array_elements(room.players) loop
    players_json := players_json || jsonb_build_array(
      jsonb_build_object(
        'id', player->>'id',
        'name', player->>'name',
        'connected', coalesce((player->>'connected')::boolean, true),
        'isBot', coalesce((player->>'bot')::boolean, false),
        'votedFor', coalesce(game->'votes' ? (player->>'id'), false)
      )
    );
  end loop;

  if game is not null and viewer_id is not null then
    viewer_assignment := game->'assignments'->(viewer_id::text);
  end if;

  return jsonb_build_object(
    'code', room.code,
    'hostId', room.host_id::text,
    'phase', room.phase,
    'round', room.round,
    'settings', room.settings,
    'players', players_json,
    'currentGame',
      case
        when game is null then null
        else jsonb_build_object(
          'category', game->'pair'->>'category',
          'startedAt', (game->>'startedAt')::bigint,
          'discussionEndsAt', (game->>'discussionEndsAt')::bigint,
          'votes', coalesce(game->'votes', '{}'::jsonb),
          'result', game->'result',
          'viewerWord', viewer_assignment->>'word',
          'viewerRole', viewer_assignment->>'role'
        )
      end
  );
end;
$$;

create or replace function ww_add_bot(p_code text, p_player_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  room ww_rooms;
  bot_id uuid := gen_random_uuid();
  bot_index integer := 1;
  bot_name text;
begin
  select * into room from ww_rooms where code = upper(trim(p_code)) for update;
  if not found then
    raise exception '방을 찾을 수 없어요.';
  end if;
  if room.host_id <> p_player_id then
    raise exception '방장만 AI를 추가할 수 있어요.';
  end if;
  if room.phase <> 'lobby' then
    raise exception '대기실에서만 AI를 추가할 수 있어요.';
  end if;
  if ww_player_count(room.players) >= 10 then
    raise exception '플레이어는 최대 10명까지 가능해요.';
  end if;

  loop
    bot_name := 'AI ' || bot_index;
    exit when not exists (
      select 1 from jsonb_array_elements(room.players) as player where player->>'name' = bot_name
    );
    bot_index := bot_index + 1;
  end loop;

  update ww_rooms
  set
    players = room.players || jsonb_build_array(
      jsonb_build_object('id', bot_id::text, 'name', bot_name, 'connected', true, 'bot', true)
    ),
    updated_at = now()
  where code = room.code
  returning * into room;

  return ww_room_state(room, p_player_id);
end;
$$;

create or replace function ww_bot_vote(p_code text, p_player_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  room ww_rooms;
  bot jsonb;
  target_id text;
  votes jsonb;
  player_count integer;
begin
  select * into room from ww_rooms where code = upper(trim(p_code)) for update;
  if not found then
    raise exception '방을 찾을 수 없어요.';
  end if;
  if room.host_id <> p_player_id then
    raise exception '방장만 AI 투표를 실행할 수 있어요.';
  end if;
  if room.phase <> 'discussion' or room.current_game is null then
    raise exception '지금은 AI 투표를 실행할 수 없어요.';
  end if;

  votes := coalesce(room.current_game->'votes', '{}'::jsonb);

  for bot in
    select *
    from jsonb_array_elements(room.players) as player
    where coalesce((player->>'bot')::boolean, false)
      and not (votes ? (player->>'id'))
  loop
    select player->>'id'
    into target_id
    from jsonb_array_elements(room.players) as player
    where player->>'id' <> bot->>'id'
    order by random()
    limit 1;

    if target_id is not null then
      votes := jsonb_set(votes, array[bot->>'id'], to_jsonb(target_id), true);
    end if;
  end loop;

  player_count := ww_player_count(room.players);

  update ww_rooms
  set
    current_game = jsonb_set(room.current_game, '{votes}', votes, true),
    updated_at = now()
  where code = room.code
  returning * into room;

  if (select count(*) from jsonb_each_text(votes)) >= player_count then
    perform ww_finish_room(p_code, room.host_id);
    select * into room from ww_rooms where code = upper(trim(p_code));
  end if;

  return ww_room_state(room, p_player_id);
end;
$$;

grant execute on function ww_add_bot(text, uuid) to anon;
grant execute on function ww_bot_vote(text, uuid) to anon;
