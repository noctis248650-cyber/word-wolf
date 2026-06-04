create or replace function ww_add_bot(p_code text, p_player_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  room ww_rooms;
  bot_id uuid := gen_random_uuid();
  bot_names text[] := array['조지', '낙화유수', '루키', '현무', '하루'];
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
    bot_name := coalesce(bot_names[bot_index], 'AI ' || bot_index);
    exit when not exists (
      select 1 from jsonb_array_elements(room.players) as player where player->>'name' = bot_name
    );
    bot_index := bot_index + 1;
  end loop;

  update ww_rooms
  set
    players = room.players || jsonb_build_array(
      jsonb_build_object('id', bot_id::text, 'name', bot_name, 'avatar', 'bot', 'connected', true, 'bot', true)
    ),
    updated_at = now()
  where code = room.code
  returning * into room;

  return ww_room_state(room, p_player_id);
end;
$$;

update ww_rooms
set
  players = (
    select coalesce(
      jsonb_agg(
        case
          when coalesce((player->>'bot')::boolean, false) and player->>'name' = 'AI 1' then jsonb_set(player, '{name}', to_jsonb('조지'::text), true)
          when coalesce((player->>'bot')::boolean, false) and player->>'name' = 'AI 2' then jsonb_set(player, '{name}', to_jsonb('낙화유수'::text), true)
          when coalesce((player->>'bot')::boolean, false) and player->>'name' = 'AI 3' then jsonb_set(player, '{name}', to_jsonb('루키'::text), true)
          when coalesce((player->>'bot')::boolean, false) and player->>'name' = 'AI 4' then jsonb_set(player, '{name}', to_jsonb('현무'::text), true)
          when coalesce((player->>'bot')::boolean, false) and player->>'name' = 'AI 5' then jsonb_set(player, '{name}', to_jsonb('하루'::text), true)
          else player
        end
        order by ord
      ),
      '[]'::jsonb
    )
    from jsonb_array_elements(players) with ordinality as item(player, ord)
  ),
  updated_at = now()
where exists (
  select 1
  from jsonb_array_elements(players) as player
  where coalesce((player->>'bot')::boolean, false)
    and player->>'name' in ('AI 1', 'AI 2', 'AI 3', 'AI 4', 'AI 5')
);

grant execute on function ww_add_bot(text, uuid) to anon;
notify pgrst, 'reload schema';
