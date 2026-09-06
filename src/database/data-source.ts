import 'dotenv/config';
import { DataSource } from 'typeorm';
import { User } from '../project/users/entities/user.entity';
import { Room } from '../project/rooms/entities/room.entity';
import { RoomMember } from '../project/rooms/entities/room-member.entity';
import { GameSession } from '../project/games/entities/game-session.entity';
import { GameTurn } from '../project/games/entities/game-turn.entity';

const AppDataSource = new DataSource({
  type: 'postgres',

  host: process.env.DB_HOST,
  port: Number(process.env.DB_PORT),
  username: process.env.DB_USERNAME,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_DATABASE,

  entities: [User, Room, RoomMember, GameSession, GameTurn],

  migrations: [__dirname + '/migrations/*{.ts,.js}'],

  synchronize: false,
});

export default AppDataSource;
