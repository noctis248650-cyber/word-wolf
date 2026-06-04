create or replace function ww_advance_phase(p_code text, p_player_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  room ww_rooms;
  now_ms bigint := floor(extract(epoch from clock_timestamp()) * 1000);
  phase_ends_at bigint;
  hint_index integer;
  next_index integer;
  next_player_id text;
  player_count integer;
begin
  select * into room from ww_rooms where code = upper(trim(p_code)) for update;
  if not found then
    raise exception '방을 찾을 수 없어요.';
  end if;
  if not ww_has_player(room.players, p_player_id) then
    raise exception '플레이어 정보를 확인할 수 없어요.';
  end if;
  if room.current_game is null or room.phase in ('lobby', 'result') then
    return ww_room_state(room, p_player_id);
  end if;

  phase_ends_at := coalesce((room.current_game->>'phaseEndsAt')::bigint, now_ms);
  if phase_ends_at > now_ms then
    return ww_room_state(room, p_player_id);
  end if;

  if room.phase = 'reveal' then
    next_player_id := room.current_game->'turnOrder'->>0;
    room := ww_set_phase(room, 'hint', 30, next_player_id, jsonb_build_object('hintIndex', 0));
  elsif room.phase = 'hint' then
    hint_index := coalesce((room.current_game->>'hintIndex')::integer, 0);
    if room.current_game->>'activePlayerId' is not null
       and not (coalesce(room.current_game->'hints', '{}'::jsonb) ? (room.current_game->>'activePlayerId')) then
      room.current_game := jsonb_set(
        room.current_game,
        array['hints', room.current_game->>'activePlayerId'],
        to_jsonb('시간 초과'::text),
        true
      );
    end if;

    next_index := hint_index + 1;
    player_count := jsonb_array_length(room.current_game->'turnOrder');

    if next_index >= player_count then
      update ww_rooms
      set current_game = room.current_game
      where code = room.code
      returning * into room;
      room := ww_set_phase(room, 'discussion', 180, null, '{}'::jsonb);
    else
      next_player_id := room.current_game->'turnOrder'->>next_index;
      update ww_rooms
      set current_game = jsonb_set(room.current_game, '{hintIndex}', to_jsonb(next_index), true)
      where code = room.code
      returning * into room;
      room := ww_set_phase(room, 'hint', 30, next_player_id, '{}'::jsonb);
    end if;
  elsif room.phase = 'discussion' then
    room := ww_set_phase(room, 'vote', 30, null, '{}'::jsonb);
  elsif room.phase = 'vote' then
    room := ww_finish_vote(room);
  elsif room.phase = 'wolf_guess' then
    perform ww_submit_wolf_guess(room.code, (room.current_game->>'activePlayerId')::uuid, '');
    select * into room from ww_rooms where code = upper(trim(p_code));
  end if;

  return ww_room_state(room, p_player_id);
end;
$$;

grant execute on function ww_advance_phase(text, uuid) to anon;
