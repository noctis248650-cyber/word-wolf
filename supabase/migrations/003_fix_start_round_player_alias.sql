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
  wolf_ids text[];
  player_json jsonb;
  assignments jsonb := '{}'::jsonb;
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

  select * into pair from ww_word_pairs order by random() limit 1;
  if pair.id is null then
    raise exception '단어 DB가 비어 있어요. Sync Word DB 액션을 먼저 실행해주세요.';
  end if;

  wolf_count := least(coalesce((room.settings->>'wolfCount')::integer, 1), greatest(1, player_count - 2));

  select array_agg(player_id)
  into wolf_ids
  from (
    select elem->>'id' as player_id
    from jsonb_array_elements(room.players) as elem
    order by random()
    limit wolf_count
  ) picked;

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
    phase = 'discussion',
    round = room.round + 1,
    current_game = jsonb_build_object(
      'pair', jsonb_build_object('villager', pair.villager, 'wolf', pair.wolf, 'category', pair.category),
      'wolfIds', to_jsonb(wolf_ids),
      'assignments', assignments,
      'votes', '{}'::jsonb,
      'startedAt', now_ms,
      'discussionEndsAt', now_ms + coalesce((room.settings->>'discussionSeconds')::integer, 180) * 1000,
      'result', null
    ),
    updated_at = now()
  where code = room.code
  returning * into room;

  return ww_room_state(room, p_player_id);
end;
$$;
