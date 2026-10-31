Your task: build a web app on top of the "Dark C. Helmet" engine.

If the feature set makes it more reasonable than a pure web app, use a lightweight node.js server for data persistent (matches, openings). The engine must be in the client!

I have marked ideas that are past MVP, so you know about them. Maybe there are decisions to be made that are influenced by knowing the longer-term plans.
## Preparations

Ensure that the engine can run as web assembly. Do not worry about the size. An initial "downloading engine" is not a problem, as long as the app and the engine are great. Worry only about the size getting to big to fit into an iPhones browser (current) or a modern Android phone's browser.

## Target platform

The app shall be responsive, run beautifully on a phone, tablet, laptop screen.


## The board

I believe there are fonts for chess pieces. Try to make the most out of them. If you find easy legally usable alternatives I am fine, but the most beautiful board is not a priority. It must be easy to read - complex chess pieces that don't look like the standard you are used to make it hard to play.
## Features

This shall be a fully featured chess program for playing against a strong engine in an enjoyable way, setting up positions, analyzing them.

It shall offer the same level of support for chess and chess960 (there are not many good engines that do). 

Features in detail:

### play an engine match

Select one of the common time controls:
* seconds per move
* minutes per game
* minutes per game + increment
* 40 moves in n minutes + k minutes for rest of game (please look up in the internet what the common approch is today - I believe in former days it was just 40 moves in e.g. 120 minutes, but now I believe after 40 moves there are different time controls)

Select whether you want to play white, black, random.

Then the game starts with human and engine moving alternatingly.

Features during play:
- Undo and the star. Create a nice shiny star icon somewhere where it makes sense. The star is alight. If you click on the star you get a text saying something like "Congrats, you haven't used an undo in this game and used no hints" (find the shortest, crispest way of saying this). If you undo a move, the star gets "outline only" and the text changed accordingly.
- Get engine evaluation and/or hint at any time. This also disables the star.
- The star has no consequences.

### making moves

- move by clicking source piece and target square
- move by clicking target square, if only one piece can move there, do it
- allow premoves, i.e. while the computer is thinking, the human can already make his next move. If the human clicks somewhere else before the computer has moved, the premove is cancelled and can be redone

### set up board

A different root level menu item / button shall offer to set up the board in the usual way:

- empty board
- initial position
- click on a square with a piece to remoe it
- click on a square without a piece and a pop-up allows piece selection (both colors). If it is easier or, in your understanding, has a better UX, you can put a list of both pieces next to the board for selection
- select castling rights. 
- select whose turn it is
- HI have no clue how to select e.P. possiblity (prio 2)

Then select either "play" or "anaylze"

### Analysis 

The player shall have the option to go to the analysis screen at any time and analyze the match so far. He shall also have the option to import a game in a standard notation (was this sgf? don't remember) and analyze this game.

For analysis of a match you can select a time control as above when playing.

when the player analyzes a position, he can start an endlessly running analysis

Analysis shows depth, nodes, value, PV.

Player can select up to 3 different lines to analyze concurrently if the engine supports this. If not: not MVP.

Also well past MVP: an analysis that allows you to follow different variations, annotate moves, variations, positions. This, today, is done in other apps in complicated ways, once we have our MVP, we have to think about this.

## Opening book

I don't want to use a standard opening book. Instead the engine shall learn openings by playing. For this the opening book shall have these options:

* show URL of opening book
* merge opening book with other opening book in that URL

When the engine plays, the app stores the position, depth, time taken to compute the PV, best move. Ensure that castling rights are part of this entry, as is "next move can be e.p."

When the engine plays at a later time, it looks for the time it wants to spend considering a move. If the opening book has a move stored with the same thinking time or higher, it will instead use this move. If a move is there with a lower time, after determining the move it will update this entry. If the engine finds a different move, it will record this as well, so we might have (position, "Nf3", 3 minutes, +0.2) and (position, "Nc3", 5 minutes, +0.1). 

To make playing not too boring, if there are several moves in a position that all are at least recorded with the same thinking time, and if their value doesn't differ by more than 0.1 pawns, a random one of these moves is selected.

## Option to run the engine on a local endpoint

This is clearly post-MVP, but of course, with a powerful mac, I would like to be able to run the app against the original engine to get its full power. Please keep in mind when building the MVP.

## Consistency

Before writing (particularly CSS) code, come up with conventions how UI elements shall look like throughout the app. LLMs today like to put everything in boxes. Avoid this except for key elements. have the same fonts, the same font sizes, the same buttons.

## Testing

Test the app thoroughly by calling the browser. Ensure it is as beautiful and consistent as you can get it.




