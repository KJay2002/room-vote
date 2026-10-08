import json
import unittest

from game import GameError, Room


class GameTests(unittest.TestCase):
    def setUp(self):
        self.room = Room("ABC123")
        self.owner, self.noor, self.morgan, self.alex, self.sam = [
            self.room.add_player(name) for name in ("Jamie", "Noor", "Morgan", "Alex", "Sam")
        ]
        for player in self.room.players.values():
            player.connected = True
        self.room.set_guests(self.owner.id, [self.alex.id, self.sam.id])
        self.room.configure(self.owner.id, self.room.questions, 10, ["Jamie", "Noor", "Morgan"])
        self.owner_option, self.noor_option, self.morgan_option = self.room.answer_options

    def vote(self, player, candidate):
        option = next(identifier for identifier, name in self.room.answer_options.items() if name == candidate.name)
        self.room.vote(player.id, option, self.room.question_index, now=101)

    def test_all_votes_count_and_matching_guest_scores(self):
        self.room.start(self.owner.id, now=100)
        for player, candidate in ((self.owner, self.noor), (self.noor, self.owner),
                                  (self.morgan, self.noor), (self.alex, self.noor),
                                  (self.sam, self.owner)):
            self.vote(player, candidate)
        self.assertFalse(self.room.finish_round(now=109.999))
        self.assertTrue(self.room.finish_round(now=110))
        result = self.room.result
        self.assertIsNotNone(result)
        self.assertEqual([row["count"] for row in result["ranking"]], [3, 2, 0])
        self.assertEqual(result["winner_id"], self.noor_option)
        self.assertEqual((self.alex.score, self.sam.score), (1, 0))
        self.assertEqual(len(result["guest_votes"]), 2)
        self.assertFalse(self.room.finish_round(now=111))
        self.assertEqual(self.alex.score, 1)

    def test_private_ballots_and_tokens_never_leak(self):
        self.room.start(self.owner.id, now=100)
        self.vote(self.alex, self.noor)
        public = self.room.view(self.morgan.id, now=101)
        self.assertNotIn("audit", public)
        self.assertNotIn("questions", public)
        self.assertIsNone(public["result"])
        self.assertIsNone(public["own_vote"])
        self.assertEqual(self.room.view(self.alex.id, now=101)["own_vote"], self.noor_option)
        audit = self.room.view(self.owner.id, now=101)["audit"]
        self.assertEqual(next(row for row in audit if row["id"] == self.alex.id)["candidate_id"],
                         self.noor_option)
        for player in self.room.players.values():
            self.assertNotIn(player.token, json.dumps(public))

    def test_owner_permissions_and_exactly_two_guests(self):
        with self.assertRaises(GameError):
            self.room.set_guests(self.noor.id, [])
        with self.assertRaises(GameError):
            self.room.start(self.noor.id, now=100)
        with self.assertRaises(GameError):
            self.room.set_guests(self.owner.id, [self.owner.id, self.alex.id])
        with self.assertRaises(GameError):
            self.room.set_guests(self.owner.id, [self.noor.id, self.alex.id, self.sam.id])
        self.room.set_guests(self.owner.id, [self.alex.id])
        with self.assertRaises(GameError):
            self.room.start(self.owner.id, now=100)

    def test_deadline_stale_round_and_guest_candidates_rejected(self):
        self.room.start(self.owner.id, now=100)
        with self.assertRaises(GameError):
            self.room.vote(self.noor.id, self.owner.id, 0, now=110)
        with self.assertRaises(GameError):
            self.room.vote(self.noor.id, self.owner.id, -1, now=101)
        with self.assertRaises(GameError):
            self.room.vote(self.noor.id, self.alex.id, 0, now=101)
        late = self.room.add_player("Late arrival", now=101)
        self.assertEqual(late.role, "player")
        with self.assertRaises(GameError):
            self.room.set_guests(self.owner.id, [])

    def test_ties_and_missing_votes_do_not_score(self):
        self.room.start(self.owner.id, now=100)
        for player, candidate in ((self.owner, self.noor), (self.noor, self.owner),
                                  (self.alex, self.noor), (self.sam, self.owner)):
            self.vote(player, candidate)
        self.room.finish_round(now=110)
        self.assertTrue(self.room.result["tied"])
        self.assertEqual((self.alex.score, self.sam.score), (0, 0))
        self.room.advance(self.owner.id, now=200)
        self.room.finish_round(now=210)
        self.assertEqual(self.room.result["total_votes"], 0)
        self.assertIsNone(self.room.result["winner_id"])
        self.assertFalse(self.room.result["tied"])

    def test_vote_changes_replace_previous_vote(self):
        self.room.start(self.owner.id, now=100)
        self.vote(self.alex, self.owner)
        self.vote(self.alex, self.noor)
        self.room.finish_round(now=110)
        self.assertEqual(self.room.result["total_votes"], 1)
        self.assertEqual(self.room.result["winner_id"], self.noor_option)

    def test_settings_final_scores_and_reset(self):
        self.room.configure(self.owner.id, ["Who is funniest?"], 10)
        self.room.start(self.owner.id, now=100)
        self.vote(self.alex, self.noor)
        self.vote(self.sam, self.noor)
        self.room.finish_round(now=110)
        self.room.advance(self.owner.id)
        self.assertEqual(self.room.phase, "finished")
        self.assertEqual((self.alex.score, self.sam.score), (1, 1))
        self.assertEqual(len(self.room.view(self.noor.id)["history"]), 1)
        self.room.reset(self.owner.id)
        self.assertEqual(self.room.phase, "lobby")
        self.assertEqual(self.alex.score, 0)
        self.assertEqual(self.room.history, [])

    def test_names_settings_and_removal(self):
        for name in ("", "  ", "JAMIE", "x" * 25):
            with self.assertRaises(GameError):
                self.room.add_player(name)
        with self.assertRaises(GameError):
            self.room.configure(self.owner.id, [], 10)
        with self.assertRaises(GameError):
            self.room.configure(self.owner.id, ["Valid?"], True)
        with self.assertRaises(GameError):
            self.room.remove_player(self.noor.id, self.morgan.id)
        self.room.remove_player(self.owner.id, self.morgan.id)
        self.assertNotIn(self.morgan.id, self.room.players)

    def test_fixed_answers_and_late_join_history(self):
        self.room.configure(self.owner.id, ["First?", "Second?"], 10, ["Absent person", "Another name"])
        self.room.start(self.owner.id, now=100)
        late = self.room.add_player("Late player", now=105)
        self.room.vote(late.id, "option-001", 0, now=106)
        self.room.vote(self.alex.id, "option-001", 0, now=106)
        self.room.finish_round(now=110)
        result = self.room.result
        self.assertEqual(result["ranking"][0]["name"], "Absent person")
        self.assertEqual(result["participant_count"], 6)
        self.assertEqual(self.alex.score, 1)
        self.room.add_player("After results", now=111)
        self.assertEqual(len(self.room.audit_history[0]["votes"]), 6)
        self.assertEqual(result["participant_count"], 6)
        self.room.advance(self.owner.id, now=120)
        snapshot = self.room.view(late.id, now=121)
        self.assertEqual(len(snapshot["history"]), 1)
        self.assertNotIn("audit_history", snapshot)
        self.assertEqual([option["name"] for option in snapshot["answer_options"]], ["Absent person", "Another name"])

    def test_join_after_deadline_finalizes_before_adding_player(self):
        self.room.start(self.owner.id, now=100)
        late = self.room.add_player("After timer", now=111)
        self.assertEqual(self.room.phase, "results")
        self.assertEqual(self.room.result["participant_count"], 5)
        self.assertNotIn(late.id, self.room.result["participant_ids"])

    def test_no_old_question_or_timer_caps_and_duplicate_answer_rejection(self):
        questions = [f"Question {index}?" for index in range(100)]
        self.room.configure(self.owner.id, questions, 3600)
        self.assertEqual(len(self.room.questions), 100)
        self.room.configure(self.owner.id, questions, 1)
        for duration in (0, -1, 1.5, True):
            with self.assertRaises(GameError):
                self.room.configure(self.owner.id, questions, duration)
        for names in ([], [""], ["Alex", " ALEX "], ["x" * 49]):
            with self.assertRaises(GameError):
                self.room.configure(self.owner.id, questions, 10, names)


if __name__ == "__main__":
    unittest.main()